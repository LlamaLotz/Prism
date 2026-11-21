/**
 * Runtime capability probe for the optional WebGPU optical glass engine.
 *
 * The stable CSS material path must keep working everywhere, so this probe is
 * deliberately conservative: any missing API, insecure context or adapter
 * failure returns a reason instead of throwing.
 */

type GpuLike = {
  requestAdapter: () => Promise<unknown | null>;
};

export type GlassCapability =
  | { ok: true }
  | { ok: false; reason: string };

export async function probeWebGpu(): Promise<GlassCapability> {
  if (typeof window === 'undefined') {
    return { ok: false, reason: 'no-window' };
  }
  if (!window.isSecureContext) {
    return { ok: false, reason: 'insecure-context' };
  }

  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  if (!gpu) {
    return { ok: false, reason: 'no-webgpu' };
  }

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return { ok: false, reason: 'no-adapter' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? `adapter-error: ${error.message}` : 'adapter-error',
    };
  }
}
