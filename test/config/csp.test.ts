/**
 * CSP ヘッダ生成の回帰テスト
 *
 * why:
 *   2026/11/04 の ZAP full-scan で `CSP: script-src unsafe-eval` が Medium として
 *   残り、`unsafe-eval` を外した (next.config.ts)。この緩和が将来の改修で
 *   知らないうちに戻ると、DAST のベースラインが崩れて再検出される。
 *   「実行時に配信されるヘッダ値」を直接アサートして、ビルド成果物ではなく
 *   設定ファイルのレベルで回帰を止める。
 */
import { describe, it, expect, afterEach } from 'vitest';
import nextConfig from '../../next.config';

/** next.config.ts の headers() から CSP ヘッダ行を取り出す */
async function getCspHeaders(): Promise<Record<string, string>> {
  const rules = await nextConfig.headers!();
  const headerList = rules.flatMap((rule) => rule.headers);
  return Object.fromEntries(headerList.map((h) => [h.key, h.value]));
}

describe('CSP header (next.config.ts)', () => {
  const originalReportOnly = process.env.CSP_REPORT_ONLY;

  afterEach(() => {
    if (originalReportOnly === undefined) delete process.env.CSP_REPORT_ONLY;
    else process.env.CSP_REPORT_ONLY = originalReportOnly;
  });

  it("script-src に 'unsafe-eval' を含めない (ZAP 10055 の再発防止)", async () => {
    const csp = (await getCspHeaders())['Content-Security-Policy'] ?? '';
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) ?? '';

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('未使用の外部 CDN (cdn.jsdelivr.net) を許可しない', async () => {
    const csp = (await getCspHeaders())['Content-Security-Policy'] ?? '';
    expect(csp).not.toContain('cdn.jsdelivr.net');
  });

  it('主要な防御ディレクティブが維持されている', async () => {
    const csp = (await getCspHeaders())['Content-Security-Policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('Stripe.js 用の許可元は維持されている', async () => {
    const csp = (await getCspHeaders())['Content-Security-Policy'] ?? '';
    expect(csp).toContain('https://*.stripe.com');
  });

  it('CSP_REPORT_ONLY=true のときは Report-Only ヘッダ名で出力する', async () => {
    process.env.CSP_REPORT_ONLY = 'true';
    const headers = await getCspHeaders();
    expect(headers['Content-Security-Policy-Report-Only']).toBeTruthy();
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });
});
