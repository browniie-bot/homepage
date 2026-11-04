import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  staticPageGenerationTimeout: 30,
  // why: ZAP DAST 初回スキャン (docs/20260503_dast-zap-initial-scan.md) で
  //   "Server Leaks Information via X-Powered-By" Low 警告が検出されたため、
  //   Next.js が自動付与する X-Powered-By ヘッダを抑止しフィンガープリントを減らす。
  poweredByHeader: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [],
  },
  async headers() {
    const reportOnly = process.env.CSP_REPORT_ONLY === 'true';

    // why: 'unsafe-eval' を許可しない。2026/11/04 の ZAP full-scan で
    //   "CSP: script-src unsafe-eval" が Medium として残っていたため、
    //   「本当に必要か」を一次情報で確認したうえで外している。
    //   不要と判断した根拠:
    //   - Next.js の本番ビルドは eval / new Function を出力しない
    //     （src/ 配下にも eval / new Function の使用箇所なし）
    //   - Stripe 公式 CSP ガイダンス (https://docs.stripe.com/security/guide) は
    //     script-src / frame-src / connect-src に「ホスト許可」のみを挙げており、
    //     'unsafe-eval' は要求していない
    //   - GTM が 'unsafe-eval' を要するのは Custom JavaScript 変数を使う場合のみ
    //     （Custom Template なら不要）。現状 GTM は未設定で読み込まれていない
    //   将来 GTM で Custom JavaScript 変数を使う運用に切り替える場合だけ、
    //   ここに 'unsafe-eval' を戻す必要がある（戻す前に Custom Template 化を検討する）。
    //
    // why: 'unsafe-inline' は残す。App Router の hydration 用インライン script と
    //   管理画面の inline style 属性が必須で、nonce 方式はリクエスト毎に HTML が
    //   変わるため CloudFront の HTML キャッシュ（s-maxage）と両立しない。
    //
    // why: cdn.jsdelivr.net を削除。ソースコード・配信 HTML のどちらにも参照が
    //   無く、許可しておく理由が無いため（不要なサプライチェーン起点を残さない）。
    //   将来 jsdelivr 配信のスクリプトを使う場合はここに戻す。
    const cspDirectives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://*.stripe.com https://*.google.com https://*.googletagmanager.com https://*.google-analytics.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.googleusercontent.com https://*.googletagmanager.com https://*.google-analytics.com",
      "font-src 'self' data:",
      "connect-src 'self' https://*.amazonaws.com https://*.google.com https://*.stripe.com https://*.googletagmanager.com https://*.google-analytics.com",
      "frame-src 'self' https://*.google.com https://*.stripe.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ];

    const cspValue = cspDirectives.join('; ');
    const headerName = reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';

    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: headerName,
            value: cspValue,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
