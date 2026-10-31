import pkg from '../package.json';

/** Build-time app version. The release workflow syncs package.json first. */
export const APP_VERSION = pkg.version;
