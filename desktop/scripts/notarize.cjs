/* eslint-disable @typescript-eslint/no-require-imports */

const { notarize } = require("@electron/notarize");

module.exports = async function notarizeMacBuild(context) {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (context.electronPlatformName !== "darwin" || !APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("Skipping notarization because Apple notarization credentials are not configured.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  await notarize({
    appPath: `${context.appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
};
