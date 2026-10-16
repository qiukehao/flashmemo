import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ImagePreview } from "../lib/attachments";

/**
 * 卡面图片放大预览（SPEC §5.4）。依赖为零：一个覆盖视口的遮罩 + 底部工具条。
 *
 * 三条硬约束（都有测试锁定）：
 * 1. **不碰被编辑的卡面**：组件由 ReviewPopup 挂在 contenteditable 之外，只读
 *    `src`，绝不写 `data-md-raw` —— 否则 autosave 会把图片引用重写一遍。
 * 2. **100% = 适应屏幕**：图片在 100% 时必然完整落在视口内（max-width/max-height
 *    由 lightboxBounds 按视口算出来）。放大是放宽这个上限，溢出的部分交给
 *    视口大小的 `.image-lightbox-stage` 内部滚动 —— 屏幕本身永不出现滚动条，
 *    窗口也不会被图片撑开（"缩放后不溢出屏幕"）。
 * 3. **键盘归预览层**：Esc 在捕获阶段吃掉并关闭，弹窗的 1/2/3、空格、Esc=跳过
 *    不会在预览开着的时候把卡片评了；焦点移到遮罩，避免"看不见的输入"打进卡面。
 */

export const LIGHTBOX_MIN_ZOOM = 0.25;
export const LIGHTBOX_MAX_ZOOM = 4;
export const LIGHTBOX_ZOOM_STEP = 0.25;
/** 遮罩给图片留的空白（px）：左右/上下各半，底部让开工具条。 */
export const LIGHTBOX_PAD_X = 48;
export const LIGHTBOX_PAD_Y = 72;

/** Clamp into the supported range; anything unusable falls back to 100%. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  const stepped = Math.round(zoom * 100) / 100;
  return Math.min(LIGHTBOX_MAX_ZOOM, Math.max(LIGHTBOX_MIN_ZOOM, stepped));
}

export function stepZoom(zoom: number, dir: 1 | -1): number {
  return clampZoom(clampZoom(zoom) + dir * LIGHTBOX_ZOOM_STEP);
}

export function zoomLabel(zoom: number): string {
  return `${Math.round(clampZoom(zoom) * 100)}%`;
}

/** 该缩放级别下图片能占的最大盒子（px）。zoom=1 恒 ≤ 视口。 */
export function lightboxBounds(
  zoom: number,
  viewportW: number,
  viewportH: number,
): { maxWidth: number; maxHeight: number } {
  const z = clampZoom(zoom);
  return {
    maxWidth: Math.round(Math.max(0, viewportW - LIGHTBOX_PAD_X) * z),
    maxHeight: Math.round(Math.max(0, viewportH - LIGHTBOX_PAD_Y) * z),
  };
}

export default function ImageLightbox({
  image,
  onClose,
}: {
  image: ImagePreview;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Esc 走捕获阶段：弹窗的全局快捷键（含 Esc=跳过本张）挂在 window 冒泡阶段，
  // 这里 stopPropagation 后它们不会收到这次按键。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // 焦点离开卡面：预览开着时的键盘输入不该落进看不见的 contenteditable。
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // 滚轮 = 缩放。必须是非 passive 监听（React 的 onWheel 是 passive 的，无法
  // 阻止遮罩后面的卡面跟着滚动）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      setZoom((z) => stepZoom(z, e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const bounds = lightboxBounds(zoom, viewport.w, viewport.h);

  return (
    <div
      ref={rootRef}
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      data-zoom={zoom}
      tabIndex={-1}
      style={{ "--lightbox-zoom": String(zoom) } as CSSProperties}
      onClick={(e) => {
        // 点遮罩（空白处）关闭；点图片本身 / 工具条不关闭。
        const target = e.target as HTMLElement | null;
        if (typeof target?.closest === "function" && target.closest("img.image-lightbox-img, .image-lightbox-bar")) {
          return;
        }
        onClose();
      }}
    >
      <div className="image-lightbox-stage">
        <img
          className="image-lightbox-img"
          src={image.url}
          alt={image.alt}
          draggable={false}
          style={{ maxWidth: `${bounds.maxWidth}px`, maxHeight: `${bounds.maxHeight}px` }}
        />
      </div>
      <div className="image-lightbox-bar" role="toolbar" aria-label="图片预览操作">
        <button
          type="button"
          className="image-lightbox-btn"
          data-action="zoom-out"
          title="缩小（滚轮向下）"
          disabled={zoom <= LIGHTBOX_MIN_ZOOM}
          onClick={() => setZoom((z) => stepZoom(z, -1))}
        >
          −
        </button>
        <span className="image-lightbox-zoom">{zoomLabel(zoom)}</span>
        <button
          type="button"
          className="image-lightbox-btn"
          data-action="zoom-in"
          title="放大（滚轮向上）"
          disabled={zoom >= LIGHTBOX_MAX_ZOOM}
          onClick={() => setZoom((z) => stepZoom(z, 1))}
        >
          ＋
        </button>
        <button
          type="button"
          className="image-lightbox-btn"
          data-action="zoom-reset"
          title="适应屏幕"
          onClick={() => setZoom(1)}
        >
          适应
        </button>
        <button
          type="button"
          className="image-lightbox-btn close"
          data-action="close"
          title="关闭（Esc）"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
