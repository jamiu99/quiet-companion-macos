// Never seed a unit-test ConfigStore with inherited real credentials or development automation switches.
for (const key of Object.keys(process.env)) if (/^(VIDU_|TOKENDANCE_|COMPANION_)/.test(key)) delete process.env[key];
// Unit tests must inject a fetcher or explicitly stub fetch. An accidental provider call fails locally, not on a bill.
globalThis.fetch = async () => { throw new Error('Network forbidden in unit tests: inject a fake fetcher'); };
