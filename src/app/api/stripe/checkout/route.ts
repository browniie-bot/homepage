import { NextRequest, NextResponse } from 'next/server';
import { getStripeAsync, BASE_PAYMENT_CONFIG, getDynamicPaymentConfig, getStripeConfig } from '@/lib/stripe';
import { getClientIp, logger } from '@/lib/env';
import { getPublicOrigin } from '@/lib/origin';
import { getUser } from '@/lib/auth';

/**
 * Stripe Checkout セッション作成 API
 *
 * why（セキュリティ設計）:
 * - userId / userEmail は **クライアントから受け取らず**、サーバー側で
 *   セッションクッキー（JWT）から取得する。クライアント送信値を信用すると、
 *   ログイン済みユーザー A が body に他人の uid を入れて POST するだけで、
 *   他人の有料アクセス権を購入できてしまう（webhook 側で
 *   metadata.userId / client_reference_id をそのまま保存するため、
 *   別ユーザの access_expiry を上書き可能）。攻撃の起点が単純な JSON
 *   改ざんで成立するため、サーバー側で必ず認証済み uid に固定する。
 * - returnUrl は同一オリジン内のパスのみ許可（open redirect 防止）。
 *
 * SBPSリンク型との対比:
 * - SBPS: HTMLフォームにhidden値を埋めてPOST + ハッシュ計算
 * - Stripe: REST API (JSON) でセッション作成 → URLにリダイレクト
 *
 * リクエスト例:
 * POST /api/stripe/checkout
 * { "returnUrl": "/articles/xxx" }
 */
export async function POST(request: NextRequest) {
  try {
    // why: 認証済みユーザーのみ購入可能。クライアント供給の userId は信用しない。
    const user = await getUser();
    if (!user.isLoggedIn || !user.uid) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const userId = user.uid;
    const userEmail = user.email ?? undefined;

    const body = await request.json().catch(() => ({}));
    const rawReturnUrl: unknown = body?.returnUrl;
    // why: open redirect 防止。同一オリジン内のパス（/ 始まり、// で始まらない）のみ許可。
    const returnUrl =
      typeof rawReturnUrl === 'string' &&
      rawReturnUrl.startsWith('/') &&
      !rawReturnUrl.startsWith('//')
        ? rawReturnUrl
        : undefined;

    // DynamoDBから動的な設定（金額、日数）を取得
    const { amount, accessDays } = await getDynamicPaymentConfig();

    // Stripe設定（Secrets Manager / env）から税率等を取得
    const stripeConfig = await getStripeConfig();

    // 成功・キャンセル時の戻りURL
    // getPublicOrigin を使う理由: Origin ヘッダーは省略される場合があり、
    // CLOUDFRONT_DOMAIN で確実に公開 URL を得る。
    const origin = getPublicOrigin(request);
    // 元の記事URLをクエリパラメータに含める
    const encodedReturnUrl = returnUrl ? encodeURIComponent(returnUrl) : '';
    const successUrl = `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}${encodedReturnUrl ? `&return_url=${encodedReturnUrl}` : ''}`;
    const cancelUrl = returnUrl ? `${origin}${returnUrl}` : `${origin}/payment/cancel`;

    // IPアドレスを取得
    const clientIp = await getClientIp();

    // --- line_items の構築 ---
    const lineItem: {
      price_data: { currency: string; product_data: { name: string; description: string }; unit_amount: number };
      quantity: number;
      tax_rates?: string[];
    } = {
      price_data: {
        currency: BASE_PAYMENT_CONFIG.currency,
        product_data: {
          name: `${BASE_PAYMENT_CONFIG.productName}（${accessDays}日間）`,
          description: BASE_PAYMENT_CONFIG.productDescription,
        },
        unit_amount: amount, // 動的に取得した金額
      },
      quantity: 1,
    };

    // ---【消費税追加】税率IDが設定されている場合、tax_ratesプロパティを追加 ---
    if (stripeConfig.taxRates) {
      lineItem.tax_rates = [stripeConfig.taxRates];
    }

    /**
     * Stripe Checkout セッション作成
     *
     * SBPSとの対比:
     * - merchant_id, service_id → 不要（APIキーで認証）
     * - cust_code → client_reference_id（ユーザー識別用）
     * - order_id → metadata.order_id（任意の追加情報）
     * - job_cd: CAPTURE → mode: 'payment'（即時売上）
     * - amount → line_items[].price_data.unit_amount
     */
    const stripe = await getStripeAsync();
    const session = await stripe.checkout.sessions.create({
      // 決済方法: クレジットカードのみ
      allowed_payment_method_types: ['card'],

      // 商品情報
      line_items: [lineItem], // 上で構築したlineItemを使用

      // 決済モード: 都度課金（即時売上確定）
      // SBPSの job_cd: CAPTURE に相当
      mode: 'payment',

      // 成功・キャンセル時のリダイレクト先
      // SBPSの success_url, cancel_url と同じ概念
      success_url: successUrl,
      cancel_url: cancelUrl,

      // ユーザー識別情報
      // SBPSの cust_code に相当
      client_reference_id: userId,

      // メールアドレス（レシート送信用）
      customer_email: userEmail,

      // 電話番号の収集を有効化
      // VISAなどカード会社への連携で必要な場合があります
      phone_number_collection: {
        enabled: true,
      },

      // 追加のメタデータ（Webhook で参照可能）
      metadata: {
        userId: userId,
        accessDays: String(accessDays), // 動的に取得した日数
        clientIp: clientIp, // IPアドレスをメタデータに含める
      },

      // 日本語ロケール
      locale: 'ja',
    });

    // セッションURLを返す（クライアントはこのURLにリダイレクト）
    return NextResponse.json({
      sessionId: session.id,
      url: session.url,
    });

  } catch (error) {
    logger.error('Stripe Checkout Session creation failed:', error);

    // why: ZAP DAST「Application Error Disclosure」対策。
    //   旧実装は error.message をそのまま JSON で返していたため、Stripe SDK や
    //   内部例外の詳細（API バージョン・stack の一部・metadata 名など）が
    //   攻撃者に漏れる恐れがあった。詳細はサーバーログにのみ記録し、
    //   レスポンスは固定文言にする。
    //   Stripe の入力検証エラーは 400 に変換（500 は本当の internal だけにする）。
    if (error instanceof Error && error.name === 'StripeInvalidRequestError') {
      return NextResponse.json(
        { error: 'invalid request' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
