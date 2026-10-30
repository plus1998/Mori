import path from "node:path";

export function windowsX64OptionalPackages(manifest) {
  return Object.entries(manifest.optionalDependencies ?? {}).filter(([name]) => /-win32-x64(?:-msvc)?$/.test(name)).map(([name, declared]) => {
    const spec = declared.startsWith("npm:") ? declared.slice(4) : `${name}@${declared}`;
    const version = spec.slice(spec.lastIndexOf("@") + 1);
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version)) throw new Error(`Windows cross-build requires an exact optional package version: ${name} ${declared}`);
    return { name, spec, version };
  });
}

export function packageNodeModulesDirectory(packageRoot, packageName) {
  return packageName.startsWith("@") ? path.dirname(path.dirname(packageRoot)) : path.dirname(packageRoot);
}
