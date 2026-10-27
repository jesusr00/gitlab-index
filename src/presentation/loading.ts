interface LoadingOutput {
  isTTY?: boolean;
  write(message: string): unknown;
}

export function startDiscoveryLoading(output: LoadingOutput = process.stderr): () => void {
  const message = 'Discovering GitLab projects...';
  if (!output.isTTY) {
    output.write(`${message}\n`);
    return () => {};
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  const render = () => output.write(`\r\x1b[2K${frames[frame++ % frames.length]} ${message}`);
  render();
  const timer = setInterval(render, 80);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    output.write('\r\x1b[2K');
  };
}
