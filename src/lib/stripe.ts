/**
 * Stripe サーバーサイドSDK
 * 
 * Stripe決済のサーバーサイド処理を提供します。
 * 
 * 【課金プラン】
 * - 金額: DynamoDB settings から取得
 * - 有効期間: DynamoDB settings から取得
 * - 方式: 都度課金（サブスクではない）
 * 
 * 【Stripe秘密鍵の取得】
 * - 本番: AWS Secrets Manager（homepage/stripe-config）から取得
 * - ローカル: 環境変数 STRIPE_SECRET_KEY から取得（フォールバック）
 */

import Stripe from 'stripe';
import { getSiteSettings } from './settings';
import { logger } from './env';

interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  taxRates?: string;
}

/**
 * Secrets Managerから Stripe 設定を取得
 */
async function getStripeConfig(): Promise<StripeConfig> {
  // ローカル開発: 環境変数を直接使用
  if (process.env.STRIPE_SECRET_KEY) {
    return {
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
      taxRates: process.env.STRIPE_TAX_RATES,
    };
  }

  // Secrets Manager から取得
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
  
  const result = await client.send(new GetSecretValueCommand({
    SecretId: 'homepage/stripe-config',
  }));

  if (!result.SecretString) {
    throw new Error('Stripe config secret is empty');
  }

  const parsed = JSON.parse(result.SecretString);
  const config = {
    secretKey: parsed.STRIPE_SECRET_KEY,
    webhookSecret: parsed.STRIPE_WEBHOOK_SECRET || '',
    taxRates: parsed.STRIPE_TAX_RATES,
  };

  logger.info('[Stripe] Secrets Manager から設定を取得しました');
  return config;
}

let _stripe: Stripe | null = null;

/**
 * Stripe SDK インスタンスを取得（遅延初期化）
 */
export async function getStripeAsync(): Promise<Stripe> {
  const config = await getStripeConfig();
  // キーが変わった場合に再初期化
  if (!_stripe) {
    _stripe = new Stripe(config.secretKey, {
      apiVersion: '2026-10-28.endive',
      typescript: true,
    });
  }
  return _stripe;
}

/**
 * 同期的な Stripe インスタンス取得（環境変数から直接）
 * Webhook など、Secrets Manager 非同期取得が不要な場合に使用
 */
export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    _stripe = new Stripe(key, {
      apiVersion: '2026-10-28.endive',
      typescript: true,
    });
  }
  return _stripe;
}

/** @deprecated getStripeAsync() を使用してください */
export const stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    return (getStripe() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/**
 * Stripe 設定をエクスポート（Secrets Manager から取得）
 */
export { getStripeConfig };

/**
 * 課金設定（基本設定）
 */
export const BASE_PAYMENT_CONFIG = {
  currency: 'jpy',
  productName: '有料記事アクセス権',
  productDescription: '全ての有料記事を読み放題',
} as const;

/**
 * DynamoDBから動的な課金設定（金額、日数）を取得する
 */
export async function getDynamicPaymentConfig() {
  const settings = await getSiteSettings();
  return {
    amount: settings?.paymentAmount || 0,
    accessDays: settings?.accessDurationDays || 0,
  };
}
