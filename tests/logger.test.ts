import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "../src/shared/logger.js";

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("info writes to stdout as [scope] · message", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.info("agent", "hello");
    expect(stdout).toHaveBeenCalledWith("[agent] · hello\n");
  });

  it("warn writes to stdout as [scope] ⚠ message", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.warn("agent", "careful");
    expect(stdout).toHaveBeenCalledWith("[agent] ⚠ careful\n");
  });

  it("cut writes to stdout as [scope] ✂ message", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.cut("server", "line cut");
    expect(stdout).toHaveBeenCalledWith("[server] ✂ line cut\n");
  });

  it("error writes to stderr (not stdout) as [scope] ✖ message", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.error("server", "broken");
    expect(stderr).toHaveBeenCalledWith("[server] ✖ broken\n");
    expect(stdout).not.toHaveBeenCalled();
  });
});
