// Fit contract: the padding is screen pixels at any scale, so a chart that
// is scaled down still keeps that margin (clear of the zoom controls).

import { computeViewportForBounds } from "../canvas-camera";

import { describe, expect, it } from "vite-plus/test";

const bounds = (width: number, height: number) => ({
  minX: 0,
  minY: 0,
  maxX: width,
  maxY: height,
  width,
  height,
});

describe("computeViewportForBounds", () => {
  it("keeps the padding in screen pixels when it scales down", () => {
    const view = computeViewportForBounds({
      bounds: bounds(1400, 400),
      canvas: { width: 760, height: 400 },
      paddingPx: 80,
    });
    expect(view.scale).toBeCloseTo(600 / 1400);
    expect(view.x).toBeCloseTo(80);
    expect(view.x + 1400 * view.scale).toBeCloseTo(680);
  });

  it("centres a chart that fits at the largest allowed scale", () => {
    const view = computeViewportForBounds({
      bounds: bounds(200, 100),
      canvas: { width: 1000, height: 600 },
      maxScale: 1,
      paddingPx: 80,
    });
    expect(view).toEqual({ scale: 1, x: 400, y: 250 });
  });

  it("lets the padding give way on a canvas smaller than twice the padding", () => {
    const view = computeViewportForBounds({
      bounds: bounds(400, 100),
      canvas: { width: 200, height: 600 },
      paddingPx: 120,
    });
    expect(view.scale).toBeCloseTo(100 / 400);
  });
});
