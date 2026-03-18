import { afterEach, describe, expect, it, vi } from "vitest";
import { probeVkBot } from "./probe.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

function mockFetchJson(body: unknown) {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as typeof fetch;
}

describe("probeVkBot", () => {
  it("returns ok=true with group info on success", async () => {
    mockFetchJson({
      response: {
        groups: [{ id: 230170267, name: "My Group", screen_name: "mygroup" }],
        profiles: [],
      },
    });

    await expect(probeVkBot("valid-token")).resolves.toEqual({
      ok: true,
      groupId: 230170267,
      groupName: "My Group",
      screenName: "mygroup",
    });
  });

  it("returns ok=false when the VK API returns an error object", async () => {
    mockFetchJson({ error: { error_msg: "Invalid access_token (4)" } });

    await expect(probeVkBot("bad-token")).resolves.toEqual({
      ok: false,
      error: "Invalid access_token (4)",
    });
  });

  it("returns ok=false when groups array is empty", async () => {
    mockFetchJson({ response: { groups: [], profiles: [] } });

    await expect(probeVkBot("valid-token")).resolves.toEqual({
      ok: false,
      error: "No group found for this token",
    });
  });

  it("returns ok=false when response has no groups property", async () => {
    mockFetchJson({ response: { profiles: [] } });

    await expect(probeVkBot("valid-token")).resolves.toEqual({
      ok: false,
      error: "No group found for this token",
    });
  });

  it("returns ok=false on network error", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed")) as unknown as typeof fetch;

    await expect(probeVkBot("any-token")).resolves.toEqual({
      ok: false,
      error: "fetch failed",
    });
  });

  it("returns ok=false on abort/timeout", async () => {
    vi.useFakeTimers();
    // Mock fetch must honour the abort signal, otherwise the promise never settles.
    global.fetch = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const pending = probeVkBot("slow-token", 100);
    await vi.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  it("returns ok=true immediately when response arrives before timeout", async () => {
    mockFetchJson({
      response: {
        groups: [{ id: 1, name: "Fast Group", screen_name: "fast" }],
        profiles: [],
      },
    });

    await expect(probeVkBot("fast-token", 5000)).resolves.toEqual({
      ok: true,
      groupId: 1,
      groupName: "Fast Group",
      screenName: "fast",
    });
  });

  it("returns ok=false when token is empty string", async () => {
    await expect(probeVkBot("")).resolves.toEqual({
      ok: false,
      error: "No token provided",
    });
  });

  it("passes access_token in fetch URL", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({
          response: { groups: [{ id: 1, name: "G", screen_name: "g" }] },
        }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await probeVkBot("mytoken123");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("access_token=mytoken123");
    expect(calledUrl).toContain("groups.getById");
  });
});
