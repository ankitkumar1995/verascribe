export type DiagnosticCheck = { name: string; passed: boolean; detail: string };
export async function runDiagnostics(
  checks: {
    name: string;
    run: () => Promise<void>;
    success: string;
    failure: string;
  }[],
) {
  const results: DiagnosticCheck[] = [];
  for (const check of checks) {
    try {
      await check.run();
      results.push({ name: check.name, passed: true, detail: check.success });
    } catch {
      results.push({ name: check.name, passed: false, detail: check.failure });
    }
  }
  return {
    ready: results.every((result) => result.passed),
    checks: results,
    note: 'Checks local prerequisites without calling generation. A live verified answer is still required.',
  };
}
