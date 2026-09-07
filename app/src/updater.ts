// Update check on launch, against the GitHub Releases feed named in
// tauri.conf.json. Signatures are Tauri's own minisign keys (the release
// workflow signs, the bundled pubkey verifies); this has nothing to do with
// Apple code signing. The user decides: a bar appears, they click.
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export async function offerUpdate(host: HTMLElement, say: (t: string, e?: boolean) => void): Promise<void> {
  let update;
  try {
    update = await check();
  } catch (err) {
    // Offline, or a dev build with no release yet: silent by design.
    console.info('update check skipped:', err);
    return;
  }
  if (!update) return;
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.innerHTML = `<span>Version ${update.version} is available.</span><button id="upd-go">Update and restart</button><button id="upd-no" class="quiet">Later</button>`;
  host.prepend(bar);
  bar.querySelector<HTMLButtonElement>('#upd-no')!.onclick = () => bar.remove();
  bar.querySelector<HTMLButtonElement>('#upd-go')!.onclick = async () => {
    bar.textContent = 'Downloading…';
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
        else if (ev.event === 'Progress') {
          got += ev.data.chunkLength;
          if (total) bar.textContent = `Downloading… ${Math.round((got / total) * 100)}%`;
        } else if (ev.event === 'Finished') bar.textContent = 'Installing…';
      });
      await relaunch();
    } catch (err) {
      say(`update failed: ${String(err)}`, true);
      bar.remove();
    }
  };
}
