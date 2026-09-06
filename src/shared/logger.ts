type Level = "info" | "warn" | "error" | "cut";

const PREFIX: Record<Level, string> = {
  info: "·",
  warn: "⚠",
  error: "✖",
  cut: "✂",
};

function emit(level: Level, scope: string, msg: string): void {
  const line = `[${scope}] ${PREFIX[level]} ${msg}`;
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  info: (scope: string, msg: string) => emit("info", scope, msg),
  warn: (scope: string, msg: string) => emit("warn", scope, msg),
  error: (scope: string, msg: string) => emit("error", scope, msg),
  cut: (scope: string, msg: string) => emit("cut", scope, msg),
};
