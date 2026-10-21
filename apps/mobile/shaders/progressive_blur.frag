#include <flutter/runtime_effect.glsl>

// Progressive gaussian (one pass of a separable H/V pair).
// Bound texture is the full backdrop; gradient is normalised over the widget
// region (uRegionOriginPx / uRegionSizePx) in device pixels.
//
// Layout for ImageFilter.shader (float slots after engine uSize):
//   0,1 : uSize (engine)
//   2   : uMaxSigma
//   3   : uFalloff
//   4   : uDirection (0 top, 1 bottom, 2 left, 3 right)
//   5   : uAxis (0 = X, 1 = Y)
//   6,7 : uRegionOriginPx
//   8,9 : uRegionSizePx
//  10   : uSolidFraction — keep full sigma for this fraction of the strong→weak
//          path, then dissolve over the remaining (1 - solid) so blur doesn't
//          "feel tall" across the whole chrome.

uniform vec2 uSize;
uniform float uMaxSigma;
uniform float uFalloff;
uniform float uDirection;
uniform float uAxis;
uniform vec2 uRegionOriginPx;
uniform vec2 uRegionSizePx;
uniform float uSolidFraction;
uniform sampler2D uTexture;

out vec4 fragColor;

const int kHalf = 48;

void main() {
  vec2 rn = clamp(
      (FlutterFragCoord().xy - uRegionOriginPx) / max(uRegionSizePx, vec2(1.0)),
      0.0,
      1.0);
  float g;
  if (uDirection < 0.5) {
    g = rn.y; // 0 = strong edge (top)
  } else if (uDirection < 1.5) {
    g = 1.0 - rn.y;
  } else if (uDirection < 2.5) {
    g = rn.x;
  } else {
    g = 1.0 - rn.x;
  }

  // Plateau of full sigma, then dissolve only in the remaining band.
  float solid = clamp(uSolidFraction, 0.0, 0.95);
  float fade = (g <= solid)
      ? 0.0
      : clamp((g - solid) / max(1.0 - solid, 0.001), 0.0, 1.0);
  float sigma = uMaxSigma * pow(max(1.0 - fade, 0.0), uFalloff);

  vec2 uv = FlutterFragCoord().xy / uSize;
#ifdef IMPELLER_TARGET_OPENGLES
  uv.y = 1.0 - uv.y;
#endif

  if (sigma < 0.5) {
    fragColor = texture(uTexture, uv);
    return;
  }

  vec2 axis = (uAxis < 0.5) ? vec2(1.0 / uSize.x, 0.0) : vec2(0.0, 1.0 / uSize.y);
  float stride = max(1.0, 3.0 * sigma / float(kHalf));
  // The old fixed kernel sampled far beyond the useful support of small
  // sigmas. Four sigma omits less than 0.007% of a continuous Gaussian's mass;
  // retain the original stride and full kernel for larger sigmas.
  float radius = min(float(kHalf), ceil(4.0 * sigma / stride));

  // Gaussian weights form a recurrence: w(i)/w(i-1) changes by a constant
  // factor. Compute exp once instead of once per tap, retaining normalisation
  // at the texture edges below.
  float ratio = exp(-0.5 * stride * stride / (sigma * sigma));
  float ratioStep = ratio * ratio;
  float w = 1.0;

  vec4 acc = texture(uTexture, uv);
  float wsum = 1.0;
  for (int i = 1; i <= kHalf; i++) {
    if (float(i) > radius) break;
    float d = float(i) * stride;
    w *= ratio;
    ratio *= ratioStep;
    vec2 off = axis * d;
    vec2 sp = uv + off;
    vec2 sm = uv - off;
    float ip = step(0.0, sp.x) * step(sp.x, 1.0) * step(0.0, sp.y) * step(sp.y, 1.0);
    float im = step(0.0, sm.x) * step(sm.x, 1.0) * step(0.0, sm.y) * step(sm.y, 1.0);
    acc += texture(uTexture, clamp(sp, 0.0, 1.0)) * (w * ip);
    acc += texture(uTexture, clamp(sm, 0.0, 1.0)) * (w * im);
    wsum += w * ip + w * im;
  }

  fragColor = acc / max(wsum, 0.0001);
}
