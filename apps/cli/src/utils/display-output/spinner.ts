/**
 * Clack spinner lifecycle helpers.
 * Owns the singleton clack spinner so callers never have to juggle the
 * handle — all renderers in display-output import `stopSpinner` from here
 * to guarantee the spinner is paused before they write.
 */
import * as clack from "@clack/prompts";

let _spinner: ReturnType<typeof clack.spinner> | null = null;

export function startSpinner(label: string): void {
  if (process.stdout.isTTY) {
    _spinner = clack.spinner();
    _spinner.start(label);
  } else {
    process.stdout.write(`${label}...\n`);
  }
}

export function updateSpinner(label: string): void {
  if (_spinner) {
    _spinner.message(label);
  } else if (!process.stdout.isTTY) {
    process.stdout.write(`${label}...\n`);
  }
}

export function stopSpinner(message?: string): void {
  if (_spinner) {
    _spinner.stop(message);
    _spinner = null;
  }
}

process.on("exit", () => {
  if (_spinner) {
    try {
      _spinner.stop();
    } catch {
      /* ignore */
    }
  }
});
