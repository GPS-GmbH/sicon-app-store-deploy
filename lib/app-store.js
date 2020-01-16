const fs = require('fs-extra')
const path = require('path')
const { curry, find, omit, propEq, chain, map, path: Rpath } = require('ramda')
const Strapi = require('strapi-sdk-javascript')
const APPSTORE_URL = 'https://app-store-api.exa.sicon.io'
const strapi = new Strapi.default(APPSTORE_URL)

async function remoteFirstTry({ remote, local }, shouldTryRemote = true) {
    const tryRemote = typeof shouldTryRemote == 'function' ? await shouldTryRemote() : shouldTryRemote
    if (!tryRemote) return local()
    try {
        return await remote()
    } catch(error) {
        console.error(error, 'now trying to fetch from local')
        return local()
    }
}

/**
 * @typedef {Object} AppFactory
 * @property {Function} getVersion
 * @property {Function} getLatestVersion
 * @property {Function} getInstalledVersion
 * @property {Function} setInstalledVersion
 * @property {Function} getChannels
 * @property {Function} getChannel
 * @property {Function} getChangelog
 * @property {Function} setChangelogCache
 * @property {Function} publishVersion
 */

/**
 * Retrieve an object with function for an app
 * @param {Object} dependencies
 * @param {String} dependencies.app - a docker namespace app name (e.g. sicon/backend)
 * @param {Object} dependencies.strapi - (optional) the strapi-sdk-javascript client to connect to
 * @param {String} dependencies.username - username for app-store.exa.sicon.io
 * @param {String} dependencies.password - password for app-store.exa.sicon.io
 * @param {String} dependencies.installedVersionPath - folder where to store installed version info
 * @param {String} dependencies.changelogPath - folder where to store changelogs
 * @returns {AppFactory}
 */
const getAppFactory = (dependencies) => {
    dependencies.strapi = dependencies.strapi || strapi
    return {
        ...dependencies,
        getInstalledChannel,
        getVersion: version => remoteFirstTry({
            remote: () => getRemoteAppVersion(dependencies, version),
            local: () => getLocalAppVersion(dependencies, version),
        }),
        /**
         * @param {String} maturity
         */
        getLatestVersion: maturity => remoteFirstTry({
            remote: () => getLatestRemoteAppVersion(dependencies, maturity),
            local: () => getLatestLocalAppVersion(dependencies),
        }),
        getInstalledVersion: () => getInstalledVersion(dependencies),
        setInstalledVersion: version => setInstalledVersion(dependencies, version),
        getChannels: () => getRemoteAppChannels(dependencies),
        getChannel: maturity => getRemoteAppChannel(dependencies, maturity),
        getChangelog: (maturity, limit, start) => remoteFirstTry({
            remote: () => getRemoteAppChangelog(dependencies, maturity, limit, start),
            local: () => getLocalAppChangelog(dependencies, limit, start),
        }),
        setChangelogCache: () => setAppChangelog(dependencies),
        publishVersion: version => publishVersion(dependencies, version),
    }
}

async function login({ strapi, username, password }) {
    try {
        return await strapi.login(username, password)
    } catch (error) {
        return error        
    }
}

const getMaturityFromVersion = ({ maturity }) => maturity

const submitGraphql = curry(async (dependencies, query) => {
    await login(dependencies)
    const { data: { data } } = await dependencies.strapi.axios.post('/graphql', { query })
    return data
})

async function publishVersion(dependencies, version) {
    const app = await getRemoteAppVersion(dependencies, version.name)
    if (app) throw new Error(`can't republish an existing version ${version.name} for app ${dependencies.app}`)
    
    const { id: channel } = await getRemoteAppChannel(dependencies, version.maturity)
    return dependencies.strapi.createEntry('versions', { ...version, channel })
}

const graphqlAppsCondition = (app, username) => `apps(where:{ dockerImage: "${app}"` + (!username ? '' : `, author: { username: "${username}" } `) + '})'

async function getRemoteAppChannels({ app, username, password, strapi }) {
    const query = `{
        ${graphqlAppsCondition(app, username)} {
            id
            channels {
                id
                maturity
            }
        }
    }`
    const { apps } = await submitGraphql({ username, password, strapi }, query)
    return apps.length && apps[0].channels.map(channel => channel.maturity)
}

async function getRemoteAppChannel({ strapi, username, password, app }, channel) {
    const query = `{
        ${graphqlAppsCondition(app, username)} {
            id
            channels(where: {maturity: "${channel}"}) {
                id
                maturity
            }
        }
    }`
    await login({strapi, username, password})
    return Rpath(['apps', 0, 'channels', 0], await submitGraphql({ username, password, strapi }, query))
}

// flatten channel and nested version objects to version objects with channel information
const chainVersions = channel => map(version => ({...version, ...(omit(['versions'], channel))}), channel.versions)
const chainChannels = chain(chainVersions)
const getVersionFromChannel = (channels, version) => find(propEq('name', version), channels)

/**
 * @param {string} app
 * @param {string} version
 * @returns
 */
async function getRemoteAppVersion({ username, password, app, strapi }, version) {
    const query = `{
        ${graphqlAppsCondition(app, username)} {
            id
            channels {
                id
                maturity
                versions(limit: 1, sort: "created_at:desc", where: { name: "${version}" }) {
                    name
                    changelog
                    dockerTag
                    created_at
                }
            }
        }
    }`
    const { apps } = await submitGraphql({ username, password, strapi }, query)
    const channels = Rpath([0, 'channels'], apps)
    return getVersionFromChannel(chainChannels(channels), version)
}

async function getLatestRemoteAppVersion(dependencies, targetMaturity) {
    const { app, username } = dependencies
    const maturity = targetMaturity || await getInstalledChannel(dependencies)
    const query = `{
        ${graphqlAppsCondition(app, username)} {
            id
            channels(where: { maturity: "${maturity}" }) {
                id
                maturity
                versions(limit: 1, sort: "created_at:desc") {
                    name
                    changelog
                    dockerTag
                    created_at
                }
            }
        }
    }`
    const { apps } = await submitGraphql(dependencies, query)
    return { ...Rpath([0, 'channels', 0, 'versions', 0], apps), maturity }
}

async function getRemoteAppChangelog(dependencies, targetMaturity, limit = 10, start = 0) {
    const { app, username } = dependencies
    const maturity = targetMaturity || await getInstalledChannel(dependencies)
    const query = `{
        ${graphqlAppsCondition(app, username)} {
            id
            channels(where: { maturity: "${maturity}" }) {
                id
                maturity
                versions(limit: ${limit}, start: ${start} sort: "created_at:desc") {
                    name
                    changelog
                    created_at
                }
            }
        }
    }`
    const { apps: [{ channels: [channel] }] } = await submitGraphql(dependencies, query)
    return channel
}

const getLocalAppVersion = async (dependencies, name) => {
    const versions = await getLocalAppChangelog(dependencies, -1)
    return versions.find(version => version.name == name)
}

const getLatestLocalAppVersion = async dependencies => {
    const latestVersion = await getLocalAppChangelog(dependencies, 1)
    return latestVersion[0]
}

const getInstalledVersion = ({ app, installedVersionPath }) => fs.readJSON(path.join(installedVersionPath, app))

async function setInstalledVersion({ app, installedVersionPath }, version) {
    const appInstalledVersionPath = path.join(installedVersionPath, app)
    await fs.ensureFile(appInstalledVersionPath)
    return fs.writeJSON(appInstalledVersionPath, version)
}

async function setAppChangelog(dependencies) {
    const { changelogPath, app } = dependencies
    const history = await getRemoteAppChangelog(dependencies, await getInstalledChannel(dependencies))
    const appChangelogPath = path.join(changelogPath, app)
    await fs.ensureFile(appChangelogPath)
    await fs.writeJSON(appChangelogPath, history)
    return history
}

async function getLocalAppChangelog({ app, changelogPath }, limit = 10, start = 0) {
    const history = await fs.readJSON(path.join(changelogPath, app))
    if (limit == -1) return history.versions
    return history.versions.slice(start, start + limit)
}

const getAppNameByVendorApp = ({ vendor, app }) => `${vendor}/${app}`
const getInstalledChannel = async dependencies => getMaturityFromVersion(await getInstalledVersion(dependencies))
const getAppByDockerImage = (dependencies, vendorAppName) => getAppFactory({ ...dependencies, app: getAppNameByVendorApp(vendorAppName) })
const getAppMaturity = async (app, maturity) => ({
    app: getAppByDockerImage(app),
    maturity: maturity || await getInstalledChannel(getAppNameByVendorApp(app))
})

// used to determine whether to use maturity or version name to determine where to update to
async function getUpdateTargetVersion(app, targetVersionName, targetVersionMaturity) {
    if (!targetVersionName && !targetVersionMaturity) return app.getLatestVersion((await app.getInstalledVersion(app)).maturity)
    if (!targetVersionName && targetVersionMaturity) return app.getLatestVersion(targetVersionMaturity)
    const targetVersion = await app.getVersion(targetVersionName)
    if (!targetVersion) throw new Error(`Update - Target version ${targetVersionName} does not exist in app-store`)
    return targetVersion
}

module.exports = {
    getAppFactory,
    setAppChangelog,
    getUpdateTargetVersion,
    getInstalledChannel,
    getAppByDockerImage,
    getAppMaturity,
    getLocalAppChangelog,
    getLocalAppVersion,
    getLatestLocalAppVersion,
    APPSTORE_URL,
}
