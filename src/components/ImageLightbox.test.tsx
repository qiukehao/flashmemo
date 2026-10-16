// @vitest-environment jsdom
import {
  act,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ImageLightbox, {
  LIGHTBOX_MAX_ZOOM,
  LIGHTBOX_MIN_ZOOM,
  LIGHTBOX_ZOOM_STEP,
  clampZoom,
  lightboxBounds,
  stepZoom,
  zoomLabel,
} from "./ImageLightbox";
import { cardImagePreview, registerMockAttachment, type ImagePreview } from "../lib/attachments";
import { renderCard } from "../lib/markdown";

const DATA_URL = "data:image/png;base64,AAAA";

// React 19 refuses to run `act` without this flag; the project has no testing-library.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("lightbox zoom math (SPEC §5.4)", () => {
  it("clamps zoom into the supported range and keeps two decimals", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0)).toBe(LIGHTBOX_MIN_ZOOM);
    expect(clampZoom(-3)).toBe(LIGHTBOX_MIN_ZOOM);
    expect(clampZoom(99)).toBe(LIGHTBOX_MAX_ZOOM);
    expect(clampZoom(1.234)).toBe(1.23);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("steps by 25% and saturates at both ends", () => {
    expect(stepZoom(1, 1)).toBe(1 + LIGHTBOX_ZOOM_STEP);
    expect(stepZoom(1, -1)).toBe(1 - LIGHTBOX_ZOOM_STEP);
    expect(stepZoom(LIGHTBOX_MAX_ZOOM, 1)).toBe(LIGHTBOX_MAX_ZOOM);
    expect(stepZoom(LIGHTBOX_MIN_ZOOM, -1)).toBe(LIGHTBOX_MIN_ZOOM);
    // Repeated steps must not drift past the cap.
    let z = 1;
    for (let i = 0; i < 20; i++) z = stepZoom(z, 1);
    expect(z).toBe(LIGHTBOX_MAX_ZOOM);
  });

  it("labels the zoom level as a percentage", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.25)).toBe("125%");
    expect(zoomLabel(99)).toBe("400%");
  });

  it("never lets the image exceed the viewport at 100% (适应屏幕)", () => {
    const bounds = lightboxBounds(1, 1024, 768);
    expect(bounds.maxWidth).toBeLessThanOrEqual(1024);
    expect(bounds.maxHeight).toBeLessThanOrEqual(768);
    // 缩放后不溢出屏幕：遮罩恒等于视口，放大后的溢出交给遮罩内部滚动，
    // 所以任何缩放级别的上限都被 MAX_ZOOM × 视口 兜住。
    for (const zoom of [0.25, 0.5, 1, 2, 4, 100]) {
      const b = lightboxBounds(zoom, 1024, 768);
      expect(b.maxWidth).toBeLessThanOrEqual(Math.round(1024 * LIGHTBOX_MAX_ZOOM));
      expect(b.maxHeight).toBeLessThanOrEqual(Math.round(768 * LIGHTBOX_MAX_ZOOM));
    }
    // Monotonic in zoom.
    expect(lightboxBounds(2, 1024, 768).maxWidth).toBeGreaterThan(bounds.maxWidth);
  });
});

/** Mirrors the ReviewPopup wiring: render markdown into a container, open a
 *  preview for the gestures `cardImagePreview` accepts, mount the lightbox. */
function CardHarness({
  markdown,
  editable = false,
  onPreview,
}: {
  markdown: string;
  editable?: boolean;
  onPreview?: (image: ImagePreview) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [image, setImage] = useState<ImagePreview | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = renderCard(markdown);
  }, [markdown]);
  const open = (e: ReactMouseEvent) => {
    const preview = cardImagePreview(e.type, e.target);
    if (!preview) return;
    onPreview?.(preview);
    setImage(preview);
  };
  return (
    <div>
      <div
        className="popup-back"
        ref={ref}
        contentEditable={editable}
        suppressContentEditableWarning
        onClick={open}
        onDoubleClick={open}
      />
      {image && <ImageLightbox image={image} onClose={() => setImage(null)} />}
    </div>
  );
}

describe("ImageLightbox (SPEC §5.4)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (ui: ReactElement) => act(() => root.render(ui));
  const query = <T extends Element>(selector: string): T | null =>
    document.querySelector<T>(selector);
  const img = () => query<HTMLImageElement>(".image-lightbox-img");
  const zoomText = () => query(".image-lightbox-zoom")?.textContent;
  const button = (action: string) =>
    query<HTMLButtonElement>(`.image-lightbox-btn[data-action="${action}"]`);
  const clickOn = (el: Element | null) =>
    act(() => void el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

  const open = () =>
    render(
      <ImageLightbox
        image={{ mdSrc: "attachment:shot.png", url: DATA_URL, alt: "架构图" }}
        onClose={() => {}}
      />,
    );

  it("shows the image with a toolbar at 100%", () => {
    open();
    expect(query(".image-lightbox")?.getAttribute("role")).toBe("dialog");
    expect(query(".image-lightbox")?.getAttribute("aria-modal")).toBe("true");
    expect(query(".image-lightbox-stage")).not.toBeNull();
    expect(img()?.getAttribute("src")).toBe(DATA_URL);
    expect(img()?.getAttribute("alt")).toBe("架构图");
    expect(zoomText()).toBe("100%");
    expect(button("close")).not.toBeNull();
  });

  it("zooms with the buttons, the wheel and the reset control", () => {
    open();
    clickOn(button("zoom-in"));
    expect(zoomText()).toBe("125%");
    clickOn(button("zoom-out"));
    expect(zoomText()).toBe("100%");

    const overlay = query(".image-lightbox")!;
    act(() =>
      void overlay.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })),
    );
    expect(zoomText()).toBe("125%");
    act(() =>
      void overlay.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true })),
    );
    expect(zoomText()).toBe("100%");

    clickOn(button("zoom-in"));
    clickOn(button("zoom-reset"));
    expect(zoomText()).toBe("100%");
  });

  it("never zooms past the ends of the range", () => {
    open();
    for (let i = 0; i < 20; i++) clickOn(button("zoom-in"));
    expect(zoomText()).toBe("400%");
    expect(query(".image-lightbox")?.getAttribute("data-zoom")).toBe(String(LIGHTBOX_MAX_ZOOM));
    expect(button("zoom-in")?.disabled).toBe(true);

    for (let i = 0; i < 40; i++) clickOn(button("zoom-out"));
    expect(zoomText()).toBe("25%");
    expect(button("zoom-out")?.disabled).toBe(true);
  });

  it("closes on Esc and swallows the key so the popup cannot also react", () => {
    let closed = 0;
    render(
      <ImageLightbox image={{ mdSrc: "", url: DATA_URL, alt: "" }} onClose={() => (closed += 1)} />,
    );
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void document.dispatchEvent(event));
    expect(closed).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("closes on a backdrop click but not on the image or the toolbar", () => {
    let closed = 0;
    render(
      <ImageLightbox image={{ mdSrc: "", url: DATA_URL, alt: "" }} onClose={() => (closed += 1)} />,
    );
    clickOn(img());
    expect(closed).toBe(0);
    clickOn(query(".image-lightbox-bar"));
    expect(closed).toBe(0);
    clickOn(query(".image-lightbox-stage"));
    expect(closed).toBe(1);
    clickOn(query(".image-lightbox"));
    expect(closed).toBe(2);
    clickOn(button("close"));
    expect(closed).toBe(3);
  });

  it("keeps the image inside the viewport at 100%", () => {
    open();
    const el = img()!;
    // `style` is live: snapshot the numbers before zooming mutates them.
    const fitWidth = Number.parseFloat(el.style.maxWidth);
    const fitHeight = Number.parseFloat(el.style.maxHeight);
    expect(fitWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(fitHeight).toBeLessThanOrEqual(window.innerHeight);
    clickOn(button("zoom-in"));
    expect(Number.parseFloat(img()!.style.maxWidth)).toBeGreaterThan(fitWidth);
    expect(Number.parseFloat(img()!.style.maxWidth)).toBeLessThanOrEqual(
      Math.round(window.innerWidth * LIGHTBOX_MAX_ZOOM),
    );
  });
});

describe("card image → lightbox (SPEC §5.4)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    registerMockAttachment("card-shot.png", DATA_URL);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (ui: ReactElement) => act(() => root.render(ui));
  const cardImage = () => host.querySelector<HTMLImageElement>("img.card-image");
  const click = (el: Element) =>
    act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  const dblclick = (el: Element) =>
    act(() => void el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));

  it("opens the lightbox for a card whose markdown carries an attachment image", () => {
    render(<CardHarness markdown={"# 图卡\n\n![示意图](attachment:card-shot.png)"} />);
    expect(cardImage()).not.toBeNull();
    expect(cardImage()?.getAttribute("src")).toBe(DATA_URL);

    click(cardImage()!);
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
    expect(document.querySelector(".image-lightbox-img")?.getAttribute("src")).toBe(DATA_URL);

    act(() =>
      void document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.querySelector(".image-lightbox")).toBeNull();
  });

  it("requires a double click inside the editable card, keeping the caret on a single click", () => {
    render(<CardHarness markdown={"![示意图](attachment:card-shot.png)"} editable />);
    const el = cardImage()!;
    click(el);
    expect(document.querySelector(".image-lightbox")).toBeNull();
    dblclick(el);
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
  });

  it("ignores the remote/missing placeholder", () => {
    render(<CardHarness markdown={"![远程](https://example.com/a.png)"} />);
    const placeholder = host.querySelector(".card-image-missing")!;
    expect(placeholder).not.toBeNull();
    click(placeholder);
    dblclick(placeholder);
    expect(document.querySelector(".image-lightbox")).toBeNull();
  });

  it("leaves the edited card DOM untouched (WYSIWYG round-trip)", () => {
    render(<CardHarness markdown={"![示意图](attachment:card-shot.png)"} editable />);
    const before = host.querySelector(".popup-back")!.innerHTML;
    dblclick(cardImage()!);
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
    act(() =>
      void document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    // 预览不写卡面 DOM：data-md-raw 原样，autosave 不会重写图片引用。
    expect(host.querySelector(".popup-back")!.innerHTML).toBe(before);
    expect(host.querySelector(".popup-back")!.innerHTML).toContain('data-md-raw="![示意图](attachment:card-shot.png)"');
  });
});
