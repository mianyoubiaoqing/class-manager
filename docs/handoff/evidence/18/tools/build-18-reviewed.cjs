const { build, Platform, Arch } = require('electron-builder');
build({ targets: Platform.WINDOWS.createTarget('dir', Arch.x64),
  config: { directories: { output: 'output/release-audit18-reviewed' },
    electronDist: 'C:/Users/flow032417/AppData/Local/class-manager-electron-probe-qXAqES' } })
  .catch((error) => { console.error(error); process.exitCode = 1; });
