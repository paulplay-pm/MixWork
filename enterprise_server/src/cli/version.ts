const VERSION = process.env.VERSION ?? 'dev';

export function run(): void {
  console.log(`mixcwork-server ${VERSION}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
