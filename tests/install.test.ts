import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

test("keys in ~/.config/model-picker/.env are read like any dotenv file", async () => {
  const home = await mkdtemp(join(tmpdir(), "mp-env-"));
  await Bun.write(
    join(home, ".config", "model-picker", ".env"),
    [
      "SINGLE='fc-single'",
      'DOUBLE="fc-double"',
      "COMMENTED=fc-commented # my key",
      "export EXPORTED=fc-exported",
      "  SPACED  =  fc-spaced  ",
      "EMPTY=",
      "# IGNORED=fc-ignored",
      "PRESET=from-file",
    ].join("\n"),
  );
  const script = `import { loadDotEnv } from ${JSON.stringify(join(ROOT, "src", "paths.ts"))};
await loadDotEnv();
const keys = ["SINGLE", "DOUBLE", "COMMENTED", "EXPORTED", "SPACED", "EMPTY", "IGNORED", "PRESET"];
console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));`;
  const run = Bun.spawn(["bun", "-e", script], {
    env: { HOME: home, PATH: Bun.env.PATH, PRESET: "from-shell" },
    stdout: "pipe",
  });
  expect(JSON.parse(await new Response(run.stdout).text())).toEqual({
    SINGLE: "fc-single",
    DOUBLE: "fc-double",
    COMMENTED: "fc-commented",
    EXPORTED: "fc-exported",
    SPACED: "fc-spaced",
    PRESET: "from-shell",
  });
});

const platform = `${process.platform}-${process.arch}`;

/** A release folder in the layout install.sh downloads, whose model-picker prints `version` or fails. */
async function release(version: string, runs: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mp-release-"));
  const name = `model-picker-${platform}`;
  const files: Record<string, string> = {
    "bin/model-picker": runs ? `#!/bin/sh\necho ${version}\n` : "#!/bin/sh\nexit 1\n",
    "pi/pi": "#!/bin/sh\necho 1.2.0\n",
  };
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, name, path, ".."), { recursive: true });
    await Bun.write(join(dir, name, path), body);
    await chmod(join(dir, name, path), 0o755);
  }
  await Bun.$`tar czf ${name}.tar.gz ${name}`.cwd(dir).quiet();
  const hash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(dir, `${name}.tar.gz`)).arrayBuffer())
    .digest("hex");
  await Bun.write(join(dir, "SHA256SUMS"), `${hash}  ${name}.tar.gz\n`);
  return dir;
}

async function install(
  home: string,
  releaseDir: string,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const run = Bun.spawn(["sh", join(ROOT, "install.sh")], {
    env: {
      HOME: home,
      PATH: Bun.env.PATH,
      MODEL_PICKER_BASE_URL: `file://${releaseDir}`,
      ...extraEnv,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  return run.exited;
}

const installedVersion = async (home: string): Promise<string> =>
  (await Bun.$`${join(home, ".local", "bin", "mp")} --version`.nothrow().quiet().text()).trim();

test.if(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"].includes(platform))(
  "an update that doesn't run leaves the previous install working",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "mp-home-"));
    expect(await install(home, await release("1.0.0", true))).toBe(0);
    expect(await installedVersion(home)).toBe("1.0.0");

    expect(await install(home, await release("2.0.0", false))).not.toBe(0);
    expect(await installedVersion(home)).toBe("1.0.0");
    expect(await readdir(join(home, ".local", "share"))).toEqual(["model-picker"]);

    expect(await install(home, await release("3.0.0", true))).toBe(0);
    expect(await installedVersion(home)).toBe("3.0.0");
  },
);

test.if(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"].includes(platform))(
  "reinstalling works when MODEL_PICKER_DIR ends in a slash",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "mp-home-"));
    const dir = { MODEL_PICKER_DIR: join(home, "tools", "model-picker") + "/" };
    expect(await install(home, await release("1.0.0", true), dir)).toBe(0);
    expect(await install(home, await release("2.0.0", true), dir)).toBe(0);
    expect(await installedVersion(home)).toBe("2.0.0");
    expect(await readdir(join(home, "tools"))).toEqual(["model-picker"]);
  },
);
