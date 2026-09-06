import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "../src/shared/logger.js";

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("info 寫入 stdout,格式為 [scope] · message", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.info("agent", "hello");
    expect(stdout).toHaveBeenCalledWith("[agent] · hello\n");
  });

  it("warn 寫入 stdout,格式為 [scope] ⚠ message", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.warn("agent", "careful");
    expect(stdout).toHaveBeenCalledWith("[agent] ⚠ careful\n");
  });

  it("cut 寫入 stdout,格式為 [scope] ✂ message", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.cut("server", "已剪線");
    expect(stdout).toHaveBeenCalledWith("[server] ✂ 已剪線\n");
  });

  it("error 寫入 stderr(而非 stdout),格式為 [scope] ✖ message", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.error("server", "壞了");
    expect(stderr).toHaveBeenCalledWith("[server] ✖ 壞了\n");
    expect(stdout).not.toHaveBeenCalled();
  });
});
