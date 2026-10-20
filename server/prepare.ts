import { ReplayError, parseImport, type PrepareInput, type Segment } from './domain';
import { Upstream, ToolGate, type BilibiliSource } from './upstream';
import { checkCodex, runCodexSelection } from './codex';

/** Runtime entry point. Injection is for offline tests, never for the normal application. */
export async function prepareReplay(input: PrepareInput, signal: AbortSignal, dependencies?: {
  source: BilibiliSource;
  select: typeof runCodexSelection;
  check: typeof checkCodex;
}): Promise<Segment[]> {
  const imported = input.mode === 'import' ? parseImport(input.input) : null;
  const source = dependencies?.source ?? new Upstream();
  const abort = () => { void source.close(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new ReplayError('CANCELLED');
    if (input.mode === 'search') await (dependencies?.check ?? checkCodex)(signal);
    if (source instanceof Upstream) await source.connect(signal);
    if (imported) {
      const metadata = await source.metadata(imported.bvid, signal);
      const selected = metadata.pages.filter(page => page.page >= imported.page);
      if (!selected.length || selected[0].page !== imported.page) throw new ReplayError('INCOMPLETE');
      return selected.map(page => ({ bvid: metadata.bvid, cid: page.cid, page: page.page }));
    }
    const credentials = await source.credentials(signal);
    if (!credentials.configured || !credentials.logged_in) throw new ReplayError('BILIBILI_LOGIN');
    const gate = new ToolGate(source, signal);
    return await (dependencies?.select ?? runCodexSelection)(input.input, gate, signal);
  } finally {
    signal.removeEventListener('abort', abort);
    await source.close();
  }
}
