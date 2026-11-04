'use client';

/**
 * 画像アップロード UI（ドラッグ＆ドロップ + クリック選択）
 *
 * why:
 *   記事生成と記事修正で画像アップロード UI が別実装になっていた。しかも
 *   ドロップ領域のスタイルは記事生成フォームの `<style jsx>` 内にしか無く、
 *   記事編集画面では枠も背景も無い小さなアイコンだけの領域になっていた。
 *   共通コンポーネント + admin.css に寄せて、両画面で同じ大きさ・同じ挙動にする。
 *
 * 「ドラッグ＆ドロップができないことがある」の主因と対策:
 *   1. 領域が小さく、狙いを外したファイルをブラウザが直接開いてしまう
 *      → ①領域を大きく確保（admin.css） ②ウィンドウ全体でファイルドラッグの
 *        dragover / drop を preventDefault し、外に落としても画面遷移させない
 *   2. アイコンや説明文など子要素をまたぐと dragleave が発火してハイライトが消える
 *      → 進入カウンタ方式（dragenter で +1 / dragleave で -1）で真に領域外へ
 *        出た時だけ解除する
 *   3. <input type="file"> の value が残り、同じファイルを選び直しても change が
 *      発火しない → 変更を受け取った直後に value を空にする
 *   4. 他タブから画像をドラッグすると dataTransfer.files が空になる
 *      → items もフォールバックで走査し、それでも取れなければ理由を画面に出す
 *        （無反応にしない）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, UploadCloud, X } from 'lucide-react';
import imageCompression from 'browser-image-compression';
import { fetchWithSigning } from '@/lib/fetch';
import {
  extractFilesFromDataTransfer,
  fileToBase64,
  selectUploadableImages,
} from '@/lib/image-upload';

/**
 * 圧縮設定（記事生成 / 記事修復で共通: 1MB・長辺 1024px）
 *
 * why: `useWebWorker: false` にしている。browser-image-compression は
 *      `useWebWorker: true` だと、ワーカー内で読み込むスクリプトの URL を
 *      既定値 `https://cdn.jsdelivr.net/npm/browser-image-compression@<ver>/dist/
 *      browser-image-compression.js` にして `importScripts` する。つまり
 *      何も指定しないと**外部 CDN からコードを読み込む**ことになり、
 *      (1) CSP で jsdelivr を許可し続ける必要が出る（攻撃面が増える）
 *      (2) サプライチェーン上の第三者が実行コードを差し替え得る
 *      (3) オフライン / CDN 障害時に圧縮が失敗する
 *      という問題がある。本サイトの画像は最大 1MB・長辺 1024px に落とす前提で
 *      1 枚あたり数百 ms 程度なので、メインスレッドで圧縮して問題ない。
 *      （体感を優先するなら `libURL` に同一オリジンのコピーを指定する手もあるが、
 *        配布物の追加ビルドが必要になるため採用していない）
 */
const COMPRESSION_OPTIONS = {
  maxSizeMB: 1,
  maxWidthOrHeight: 1024,
  useWebWorker: false,
};

export interface ImageUploaderProps {
  /** アップロード済み画像の URL 配列（状態は親フォームが保持する） */
  value: string[];
  onChange: (urls: string[]) => void;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  /** AI 処理中など、親フォームが送信中で操作させたくないときに true */
  disabled?: boolean;
}

/**
 * 画像をリサイズ・圧縮する。
 * why: Lambda のリクエストサイズと S3 の容量を抑えるため、送信前に必ず縮小する。
 *      圧縮に失敗しても元ファイルでアップロードを継続する（アップロード自体を
 *      失敗させない方がユーザー体験として良い）。
 */
async function optimizeImage(file: File): Promise<File> {
  try {
    return await imageCompression(file, COMPRESSION_OPTIONS);
  } catch {
    return file;
  }
}

export default function ImageUploader({
  value,
  onChange,
  label,
  hint,
  disabled = false,
}: ImageUploaderProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** ドラッグの進入深度。子要素をまたぐたびに dragleave が飛ぶのを吸収する */
  const dragDepth = useRef(0);
  /** 非同期アップロード完了時に最新の value を参照するためのミラー */
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  /**
   * ファイルドラッグ中だけウィンドウ全体で既定動作を止める。
   * why: ドロップ領域を外したときにブラウザが画像ファイルを新しいタブで開き、
   *      入力中のフォーム内容が失われるのを防ぐ。テキスト選択のドラッグなど
   *      Files を含まないドラッグには影響させない。
   */
  useEffect(() => {
    const isFileDrag = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const prevent = (event: DragEvent) => {
      if (isFileDrag(event)) event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  /** 選択・ドロップされたファイルをまとめて S3 にアップロードする */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (disabled) return;

      const { accepted, rejected } = selectUploadableImages(files);
      // why: 却下理由とアップロード失敗理由を別々に setError すると後の上書きで
      //      片方が消える。両方を集めて最後に 1 回だけ表示する。
      const problems = rejected.map((item) => `「${item.name}」は${item.reason}`);
      setError(null);
      if (accepted.length === 0) {
        setError(problems.join('\n') || null);
        return;
      }

      setIsUploading(true);
      const uploadedUrls: string[] = [];

      await Promise.all(
        accepted.map(async (file) => {
          try {
            const optimized = await optimizeImage(file);
            const dataBase64 = await fileToBase64(optimized);
            const res = await fetchWithSigning('/api/admin/upload', {
              method: 'POST',
              body: JSON.stringify({
                filename: optimized.name || file.name,
                contentType: optimized.type || 'image/jpeg',
                dataBase64,
              }),
            });
            const data = await res.json();
            if (data.status === 'error' || typeof data.publicUrl !== 'string') {
              problems.push(`「${file.name}」: ${data.message ?? 'アップロードに失敗しました'}`);
              return;
            }
            uploadedUrls.push(data.publicUrl);
          } catch {
            problems.push(`「${file.name}」: 通信に失敗しました`);
          }
        })
      );

      // why: 複数ファイルを並列アップロードするので、追加分は「今の値」に追記する。
      //      アップロード中にユーザーが既存プレビューを削除していても壊れないよう
      //      最新の value を ref 経由で読む。
      if (uploadedUrls.length > 0) {
        onChange([...valueRef.current, ...uploadedUrls]);
      }
      if (problems.length > 0) {
        setError(problems.join('\n'));
      }
      setIsUploading(false);
    },
    [disabled, onChange]
  );

  /** <input type="file"> の選択結果を受け取る */
  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // why: value を消さないと同じファイルを続けて選んだときに change が発火しない
    event.target.value = '';
    void uploadFiles(files);
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current += 1;
    if (!disabled) setIsDragOver(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    // why: dragover で preventDefault しないと drop イベント自体が発火しない
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    }
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    if (disabled) return;

    const files = extractFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) {
      // 他タブの画像を直接ドラッグした場合など、ブラウザが File を渡さないケース
      const hasFileDrag = Array.from(event.dataTransfer?.types ?? []).includes('Files');
      if (hasFileDrag) {
        setError(
          '画像を読み取れませんでした。ブラウザ上の画像を直接ドラッグした場合は、一度デスクトップに保存してからドロップしてください。'
        );
      }
      return;
    }
    void uploadFiles(files);
  };

  const openFileDialog = () => {
    if (disabled || isUploading) return;
    fileInputRef.current?.click();
  };

  const removeImage = (url: string) => {
    onChange(valueRef.current.filter((item) => item !== url));
  };
  return (
    <div className="admin-form-group">
      {label && <label htmlFor="admin-image-uploader-input">{label}</label>}
      <div
        className={`admin-image-dropzone${isDragOver ? ' drag-over' : ''}${disabled ? ' is-disabled' : ''}`}
        onClick={openFileDialog}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openFileDialog();
          }
        }}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="画像をアップロード（クリックまたはドラッグ＆ドロップ）"
        aria-disabled={disabled}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          id="admin-image-uploader-input"
          type="file"
          multiple
          accept="image/*"
          ref={fileInputRef}
          onChange={handleInputChange}
          style={{ display: 'none' }}
        />
        <UploadCloud size={40} aria-hidden="true" />
        <p className="admin-image-dropzone__title">画像をドラッグ＆ドロップ</p>
        <p className="admin-image-dropzone__hint">またはクリックして選択（複数可・1 枚 10MB まで）</p>
        {hint && <p className="admin-image-dropzone__hint">{hint}</p>}
        {isUploading && (
          <div className="admin-image-dropzone__uploading">
            <Loader2 size={16} className="loading-spin" />
            <span>アップロード中...</span>
          </div>
        )}
      </div>

      {error && (
        <p className="admin-image-uploader__error" role="alert" style={{ whiteSpace: 'pre-wrap' }}>
          {error}
        </p>
      )}

      {value.length > 0 && (
        <div className="admin-image-preview-grid">
          {value.map((url, index) => (
            <div key={`${url}-${index}`} className="admin-image-preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={`アップロード済み画像 ${index + 1}`} />
              <button
                type="button"
                onClick={() => removeImage(url)}
                className="admin-image-preview__remove"
                aria-label={`アップロード済み画像 ${index + 1} を削除`}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
