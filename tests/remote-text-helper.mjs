import { execFileSync } from 'node:child_process';

// Execute the actual remote shell locally, then emulate SSM's stdout ceiling.
// runRemoteShell applies the real adapter redactor to these responses.
export function localSsmText({ replace = text => text, mutate = text => text } = {}) {
  const invocations = new Map();
  const outputLengths = [];
  let id = 0;
  const runAws = async args => {
    if (args[0] !== 'ssm') throw new Error('Offline fixture forbids AWS calls');
    if (args[1] === 'send-command') {
      const command = JSON.parse(args[args.indexOf('--parameters') + 1]).commands.join('\n');
      let stdout = '', stderr = '', code = 0;
      try {
        stdout = execFileSync('bash', ['-c', replace(command)], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      } catch (error) {
        stdout = String(error.stdout || ''); stderr = String(error.stderr || ''); code = error.status || 1;
      }
      outputLengths.push(stdout.length);
      const commandId = `fixture-${++id}`;
      invocations.set(commandId, { Status: code ? 'Failed' : 'Success', ResponseCode: code,
        StandardOutputContent: mutate(stdout).slice(0, 24000), StandardErrorContent: stderr });
      return { code: 0, stdout: JSON.stringify({ Command: { CommandId: commandId } }), stderr: '' };
    }
    if (args[1] === 'get-command-invocation')
      return { code: 0, stdout: JSON.stringify(invocations.get(args[args.indexOf('--command-id') + 1])), stderr: '' };
    throw new Error('Unexpected offline SSM operation');
  };
  return { runAws, outputLengths };
}
