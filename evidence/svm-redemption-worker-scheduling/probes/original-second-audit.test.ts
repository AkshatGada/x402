import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BatchChannelManager } from "../validation/typescript/packages/mechanisms/svm/src/batch-settlement/server/channelManager";
import { MemoryChannelStore } from "../validation/typescript/packages/mechanisms/svm/src/batch-settlement/server/storage";
import { SOLANA_DEVNET_CAIP2 } from "../validation/typescript/packages/mechanisms/svm/src/constants";
import { USDC_DEVNET_ADDRESS } from "../validation/typescript/packages/mechanisms/svm/src/defaultAssets";

const releases: (() => void)[] = [];
const managers: BatchChannelManager[] = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => (resolve = done));
  releases.push(resolve);
  return { promise, resolve };
}
function fixture(onError?: (error: unknown) => void) {
  const store = new MemoryChannelStore();
  const list = vi.spyOn(store, "list");
  const manager = new BatchChannelManager({
    store, onError,
    requirements: {
      amount: "1000", asset: USDC_DEVNET_ADDRESS, extra: {}, maxTimeoutSeconds: 300,
      network: SOLANA_DEVNET_CAIP2, payTo: USDC_DEVNET_ADDRESS, scheme: "batch-settlement",
    },
    settle: async () => { throw new Error("unexpected settlement"); },
  });
  managers.push(manager);
  return { manager, list };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  vi.clearAllTimers();
  releases.splice(0).forEach(release => release());
  await Promise.all(managers.splice(0).map(manager => manager.stop()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("invalidates an accepted tick before its first promise microtask without manual work", async () => {
  const { manager, list } = fixture();
  manager.start(1);
  vi.advanceTimersByTime(1000);
  expect(list).not.toHaveBeenCalled();
  const stopped = manager.stop();
  manager.start(1);
  await vi.advanceTimersByTimeAsync(0);
  await stopped;
  expect(list).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(list).toHaveBeenCalledTimes(2);
});

it("releases the accepted tick gate after an onError callback reenters stop/start", async () => {
  let stopped!: Promise<void>;
  const error = new Error("first list rejected");
  const onError = vi.fn(received => {
    expect(received).toBe(error);
    stopped = manager.stop();
    manager.start(1);
  });
  const { manager, list } = fixture(onError);
  list.mockRejectedValueOnce(error);
  manager.start(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  await stopped;
  await vi.advanceTimersByTimeAsync(1000);
  expect(list).toHaveBeenCalledTimes(3);
});

it("resolves a failed final flush while a manual pass queued by its onError stays blocked", async () => {
  const blocked = gate();
  const error = new Error("flush list rejected");
  let later!: Promise<unknown>;
  const onError = vi.fn(received => {
    expect(received).toBe(error);
    later = manager.redeem();
  });
  const { manager, list } = fixture(onError);
  list.mockRejectedValueOnce(error).mockImplementationOnce(async () => {
    await blocked.promise;
    return [];
  });
  let stopped = false;
  const stop = manager.stop({ flush: true }).then(() => (stopped = true));
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  expect(list).toHaveBeenCalledTimes(2);
  expect(stopped).toBe(true);
  blocked.resolve();
  await Promise.all([stop, later]);
  expect(list).toHaveBeenCalledTimes(3);
});
