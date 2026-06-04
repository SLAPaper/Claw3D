import { useEffect, useMemo } from "react";
import * as THREE from "three";

export const CANVAS_TEXT_FONT_FAMILY = [
  "system-ui",
  "-apple-system",
  "BlinkMacSystemFont",
  '"Segoe UI"',
  '"Microsoft YaHei"',
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Noto Sans CJK SC"',
  '"Noto Sans SC"',
  "Arial",
  "sans-serif",
].join(", ");

type CanvasTextPlaneProps = {
  text: string;
  width: number;
  height: number;
  color: string;
  fontSizePx: number;
  fontWeight?: number | string;
  align?: CanvasTextAlign;
  lineHeight?: number;
  paddingX?: number;
  opacity?: number;
  renderOrder?: number;
  depthTest?: boolean;
  depthWrite?: boolean;
  position?: [number, number, number];
};

type CanvasTextAlign = "left" | "center" | "right";

const resolveCanvasX = (
  align: CanvasTextAlign,
  canvasWidth: number,
  paddingX: number,
) => {
  if (align === "left") return paddingX;
  if (align === "right") return canvasWidth - paddingX;
  return canvasWidth / 2;
};

export function CanvasTextPlane({
  text,
  width,
  height,
  color,
  fontSizePx,
  fontWeight = 700,
  align = "center",
  lineHeight = 1.15,
  paddingX = 32,
  opacity = 1,
  renderOrder,
  depthTest = true,
  depthWrite = false,
  position = [0, 0, 0],
}: CanvasTextPlaneProps) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = Math.max(
      64,
      Math.min(512, Math.round(canvas.width * (height / Math.max(width, 0.001)))),
    );
    const ctx = canvas.getContext("2d");
    if (!ctx) return new THREE.CanvasTexture(canvas);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${fontWeight} ${fontSizePx}px ${CANVAS_TEXT_FONT_FAMILY}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";

    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    const lineHeightPx = fontSizePx * lineHeight;
    const totalTextHeight = Math.max(fontSizePx, lines.length * lineHeightPx);
    const startY = canvas.height / 2 - totalTextHeight / 2 + lineHeightPx / 2;
    const x = resolveCanvasX(align, canvas.width, paddingX);

    lines.forEach((line, index) => {
      ctx.fillText(line, x, startY + index * lineHeightPx);
    });

    const nextTexture = new THREE.CanvasTexture(canvas);
    nextTexture.colorSpace = THREE.SRGBColorSpace;
    nextTexture.minFilter = THREE.LinearFilter;
    nextTexture.magFilter = THREE.LinearFilter;
    nextTexture.generateMipmaps = false;
    nextTexture.needsUpdate = true;
    return nextTexture;
  }, [align, color, fontSizePx, fontWeight, height, lineHeight, paddingX, text, width]);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh position={position} renderOrder={renderOrder}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={opacity}
        depthTest={depthTest}
        depthWrite={depthWrite}
        toneMapped={false}
      />
    </mesh>
  );
}
