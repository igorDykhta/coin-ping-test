const major = Number.parseInt(process.versions.node.split(".")[0], 10);

if (major < 20) {
  console.error(
    [
      "",
      `Node.js 20+ is required (current: ${process.version}).`,
      "This project includes a .nvmrc file. With nvm, run:",
      "",
      "  nvm use",
      "  yarn dev",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
