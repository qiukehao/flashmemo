import { describe, expect, it, vi } from "vitest";
import { createSessionLoader } from "./reviewSession";

describe("review session loading", () => {
  it("reuses a consuming request across effect replay", async () => {
    const read = vi.fn().mockResolvedValue([1, 2]);
    const load = createSessionLoader(read);
    const first = load(1);
    const replay = load(1);
    expect(first).toBe(replay);
    expect(await replay).toEqual([1, 2]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("loads a new batch when the reusable window opens again", async () => {
    const read = vi.fn().mockResolvedValueOnce([1]).mockResolvedValueOnce([2]);
    const load = createSessionLoader(read);
    expect(await load(1)).toEqual([1]);
    expect(await load(2)).toEqual([2]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
