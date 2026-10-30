export function nativePackTarget(args = process.argv.slice(2), host = process) {
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    const result = args[index + 1];
    if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
    return result;
  };
  return { platform: value("--platform", host.platform), arch: value("--arch", host.arch) };
}
