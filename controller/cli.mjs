import {readFile, realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {POLICY, ControlError, inspectLedger, planCases, runBatch} from './controller.mjs';
const directory = fileURLToPath(new URL('./state/', import.meta.url));
try {
  const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
  const authorization = JSON.parse(await readFile(new URL('./authorization.json', import.meta.url), 'utf8'));
  const mode = process.argv[2] || '--plan';
  if (process.argv.length > 3 || !['--plan', '--execute-first-three', '--execute-first-one', '--execute-next-two', '--execute-second-one', '--execute-third-one', '--execute-fourth-one', '--execute-validation-pair'].includes(mode)) throw new ControlError('ARGUMENTS_REJECTED');
  if (await realpath(directory) !== directory.replace(/\/$/, '')) throw new ControlError('STATE_DIRECTORY_IS_SYMLINK');
  if (mode === '--plan') {
    const ledger = await inspectLedger(directory);
    console.log(JSON.stringify({mode: 'plan-only', noNetworkRequests: true, noCredentialRead: true, policy: POLICY,
      executionCoordinated: authorization.coordinatorApproved === true,
      authenticationDestinationApiOnlyConfirmed: authorization.authenticationDestinationApiOnlyConfirmed === true,
      userAcceptedCurrentSecretScope: authorization.userAcceptedCurrentSecretScope === true,
      secretAuthorizationScopeNarrowed: authorization.secretAuthorizationScopeNarrowed === true,
      requestCount: ledger.requestCount, exposureMicroUsd: ledger.exposureMicroUsd, stopReason: ledger.stopReason,
      firstThree: await planCases(cases.slice(0, 3)), fourth: await planCases(cases.slice(3, 4)), additional: await planCases(cases.slice(4, 6))}, null, 2));
  } else {
    if (!process.execArgv.includes('--use-env-proxy')) throw new ControlError('MANAGED_PROXY_FLAG_REQUIRED');
    const selected = mode === '--execute-first-one' ? cases.slice(0, 1) : mode === '--execute-second-one' ? cases.slice(1, 2) : mode === '--execute-third-one' ? cases.slice(2, 3) : mode === '--execute-fourth-one' ? cases.slice(3, 4) : mode === '--execute-validation-pair' ? cases.slice(4, 6) : mode === '--execute-next-two' ? cases.slice(1, 3) : cases.slice(0, 3);
    const result = await runBatch({directory, cases: selected, authorization,
      getKey: () => process.env.TRAILBRIEF_API_KEY,
      transport: (url, options) => fetch(url, options)});
    console.log(JSON.stringify({mode, ...result}));
  }
} catch (error) {
  console.log(JSON.stringify({stopped: true, code: error instanceof ControlError ? error.code : 'LOCAL_VERIFICATION_ERROR'}));
  process.exitCode = 1;
}
