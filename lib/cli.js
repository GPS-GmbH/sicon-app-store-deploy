const {
    getVersionInfo,
    getDryRunVersionInfo,
    printDryRunVersionFromStdIn,
    publish,
    publishVersionFromStdIn,
} = require('.')

const meow = require('meow')
meow(`
    Usage
      $ sicon-app-store-deploy
`)