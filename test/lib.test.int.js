import test from 'ava'
const fs = require('fs-extra')
const path = require('path')
const Strapi = require('strapi-sdk-javascript')
const appStore = require('../lib/app-store')

const installedVersionPath = './tmp/installed'
const changelogPath = './tmp/changelog'

const strapi = new Strapi.default(appStore.APPSTORE_URL)
const dependencies = { 
    installedVersionPath,
    changelogPath,
    strapi,
    username: 'sicon',
    password: '',
}

const getApp = app => appStore.getAppFactory({ ...dependencies, app })
const sicon = getApp('sicon/backend')

test.serial('set installed version', async t => {
    await sicon.setInstalledVersion({
        "name": "m1.0.0",
        "changelog": "testing",
        "dockerTag": "master",
        "maturity": "alpha"
    })
    t.true(await fs.pathExists(path.join(installedVersionPath, 'sicon/backend')))
})

test.serial('set changelog', async t => {
    await sicon.setChangelogCache()
    t.true(await fs.pathExists(path.join(changelogPath, 'sicon/backend')))
})

test.serial('get latest local version', async t => {
    const latest = await appStore.getLatestLocalAppVersion({ ...dependencies, app: 'sicon/backend' })
    t.true('changelog' in latest)
})

test.serial('get app channels', async t => {
    const channels = await sicon.getChannels()
    t.true(channels.includes('stable'))
})

test.serial('get specific version', async t => {
    const release10 = await sicon.getVersion('r0.10.0')
    t.true('changelog' in release10)
    t.true('name' in release10)
})

test.serial('get specific version from local cache', async t => {
    const changelog = await appStore.getLocalAppChangelog({ ...dependencies, app: 'sicon/backend' })
    const name = changelog[0].name
    const changelogVersion = await appStore.getLocalAppVersion({ ...dependencies, app: 'sicon/backend' }, name)
    t.true('changelog' in changelogVersion)
})

test.serial('get update target version for specific version', async t => {
    const nextVersion = await appStore.getUpdateTargetVersion(sicon, 'b0.11.0')
    t.true('dockerTag' in nextVersion)
})

test.serial('get update target version for specific maturity', async t => {
    const nextVersion = await appStore.getUpdateTargetVersion(sicon, false, 'beta')
    t.true('dockerTag' in nextVersion)
})

test.serial('figure out update target version based on installed version', async t => {
    const nextVersion = await appStore.getUpdateTargetVersion(sicon)
    t.true('dockerTag' in nextVersion)
})

test.serial('get latest tag', async t => {
    const tag = await sicon.getLatestVersion()
    t.true('changelog' in tag)
})

test.serial('get current version', async t => {
    const tag = await sicon.getInstalledVersion()
    t.true('changelog' in tag)
})

test.serial('get a changelog of versions', async t => {
    const tags = await sicon.getChangelog()
    t.truthy(tags.versions.length)
})

test.serial('get installed channel', async t => {
    const channel = await appStore.getInstalledChannel({ ...dependencies, app: 'sicon/backend'})
    t.is(channel, 'alpha')
})

test.after(async t => {
    fs.remove('./tmp')
})