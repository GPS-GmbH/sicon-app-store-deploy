import * as fs from 'fs-extra'
import * as path from 'path'
import { find, omit, propEq, chain, map, path as Rpath } from 'ramda'
import Strapi from 'strapi-sdk-javascript'

export const APPSTORE_URL = 'https://app-store-api.service.sicon.eco'
const strapi = new Strapi(APPSTORE_URL)

const remoteFirstTry = async <RemoteResult, LocalResult = RemoteResult>({ remote, local }: { remote: () => Promise<RemoteResult | undefined>, local: () => Promise<LocalResult> }, shouldTryRemote: boolean | (() => void) = true) => {
    const tryRemote = typeof shouldTryRemote == 'function' ? await shouldTryRemote() : shouldTryRemote
    if (!tryRemote) return local()
    try {
        return await remote()
    } catch(error) {
        console.error(error, 'now trying to fetch from local')
        return local()
    }
}

export type VersionMaturity = 'alpha' | 'beta' | 'stable'
export interface Version {
    id: number
    maturity: VersionMaturity
    name: string
    changelog: string
    dockerTag: string
    created_at: Date
}

export interface RemoteChannel {
    id: number
    maturity: VersionMaturity
}

export interface RemoteChannelVersions extends RemoteChannel {
    versions: Version[]
}

export interface RemoteApp<ExtendedChannel = RemoteChannel> {
    id: number
    channels: ExtendedChannel[]
}

export interface Options {
    /** a docker namespace app name (e.g. sicon/backend) */
    app: string
    /** (optional) the strapi-sdk-javascript client to connect to */
    strapi?: Strapi
    /** username for app-store.exa.sicon.io */
    username: string
    /** password for app-store.exa.sicon.io */
    password: string
    /** folder where to store installed version info */
    installedVersionPath: string
    /** folder where to store changelogs */
    changelogPath: string
    /** space separated list of fields to fetch from graphql */
    retrieveVersionFields?: string
    /** Define whether to only read files or attempt to fetch remote version info */
    shouldTryRemote?: boolean
}

export type Dependencies = Required<Options>

/**
 * Retrieve an object with function for an app
 */
export const getAppFactory = (userDependencies: Options) => {
    const dependencies = {
        strapi,
        shouldTryRemote: true,
        retrieveVersionFields: `
            id
            name
            changelog
            dockerTag
            created_at
        `,
        ...userDependencies
    }
    return {
        ...dependencies,
        getInstalledChannel,
        getVersion: (version: string) => remoteFirstTry<Version | undefined>({
            remote: () => getRemoteAppVersion(dependencies, version),
            local: () => getLocalAppVersion(dependencies, version),
        }, dependencies.shouldTryRemote),
        getLatestVersion: (maturity: VersionMaturity) => remoteFirstTry<Version>({
            remote: () => getLatestRemoteAppVersion(dependencies, maturity),
            local: () => getLatestLocalAppVersion(dependencies),
        }, dependencies.shouldTryRemote),
        getInstalledVersion: () => getInstalledVersion(dependencies),
        setInstalledVersion: (version: string) => setInstalledVersion(dependencies, version),
        getChannels: () => getRemoteAppChannels(dependencies),
        getChannel: (maturity: VersionMaturity) => getRemoteAppChannel(dependencies, maturity),
        getChangelog: (maturity: VersionMaturity, limit: number, start: number) => remoteFirstTry<RemoteChannelVersions>({
            remote: () => getRemoteAppChangelog(dependencies, maturity, limit, start),
            local: () => getLocalAppChangelog(dependencies, limit, start),
        }, dependencies.shouldTryRemote),
        setChangelogCache: () => setLocalAppChangelog(dependencies),
        publishVersion: (version: Version) => publishVersion(dependencies, version),
    }
}

const login = async ({ strapi, username, password }: Dependencies) => {
    if (strapi.axios.defaults.headers.common.Authorization) return
    try {
        return await strapi.login(username, password)
    } catch (error) {
        return error        
    }
}

const submitGraphql = async <T>(dependencies: Dependencies, query: string) => {
    await login(dependencies)
    const { data: { data } } = await dependencies.strapi.axios.post<{ data: T }>('/graphql', { query })
    return data
}

const publishVersion = async (dependencies: Dependencies, version: Version) => {
    const app = await getRemoteAppVersion(dependencies, version.name)
    if (app) throw new Error(`can't republish an existing version ${version.name} for app ${dependencies.app}`)
    const channel = (await getRemoteAppChannel(dependencies, version.maturity))?.id
    return dependencies.strapi.createEntry('versions', { ...version, channel })
}

const graphqlAppsCondition = (app: string, username: string) => `apps(where:{ dockerImage: "${app}"` + (!username ? '' : `, author: { username: "${username}" } `) + '})'

const getRemoteAppChannels = async (dependencies: Dependencies) => {
    const query = `{
        ${graphqlAppsCondition(dependencies.app, dependencies.username)} {
            id
            channels {
                id
                maturity
            }
        }
    }`
    const { apps } = await submitGraphql<{ apps: RemoteApp[] }>(dependencies, query)
    return apps.length && apps[0].channels.map(channel => channel.maturity)
}

const getRemoteAppChannel = async (dependencies: Dependencies, channel: VersionMaturity) => {
    const query = `{
        ${graphqlAppsCondition(dependencies.app, dependencies.username)} {
            id
            channels(where: {maturity: "${channel}"}) {
                id
                maturity
            }
        }
    }`
    await login(dependencies)
    return Rpath<RemoteChannel>(['apps', 0, 'channels', 0], await submitGraphql<{ apps: RemoteApp[] }>(dependencies, query))
}

// flatten channel and nested version objects to version objects with channel information
const chainVersions = (channel: RemoteChannelVersions): Version[] => map(version => ({...version, ...(omit(['versions'], channel))}), channel.versions)
const chainChannels = chain(chainVersions)
const findVersionByName = (versions: Version[] = [], version: string) => find(propEq('name', version), versions)

const getRemoteAppVersion = async (dependencies: Dependencies, version: string) => {
    const query = `{
        ${graphqlAppsCondition(dependencies.app, dependencies.username)} {
            id
            channels {
                id
                maturity
                versions(limit: 1, sort: "created_at:desc", where: { name: "${version}" }) {
                    ${dependencies.retrieveVersionFields}
                }
            }
        }
    }`
    const { apps } = await submitGraphql<{ apps: RemoteApp<RemoteChannelVersions>[] }>(dependencies, query)
    const channels = Rpath<RemoteChannelVersions[]>([0, 'channels'], apps)
    if (!channels) return
    return findVersionByName(chainChannels(channels), version)
}

const getLatestRemoteAppVersion = async (dependencies: Dependencies, targetMaturity: VersionMaturity) => {
    const { app, username } = dependencies
    const maturity = targetMaturity || await getInstalledChannel(dependencies)
    const query = `{
        ${graphqlAppsCondition(app, username)} {
            id
            channels(where: { maturity: "${maturity}" }) {
                id
                maturity
                versions(limit: 1, sort: "created_at:desc") {
                    ${dependencies.retrieveVersionFields}
                }
            }
        }
    }`
    const { apps } = await submitGraphql<{ apps: RemoteApp<RemoteChannelVersions>[] }>(dependencies, query)
    if (!apps?.[0]?.channels?.[0]?.versions?.[0]) return
    return { ...Rpath<Version>([0, 'channels', 0, 'versions', 0], apps) as Version, maturity }
}

const getRemoteAppChangelog = async (dependencies: Dependencies, targetMaturity: VersionMaturity, limit = 10, start = 0) => {
    const { app, username } = dependencies
    const maturity = targetMaturity || await getInstalledChannel(dependencies)
    const query = `{
        ${graphqlAppsCondition(app, username)} {
            id
            channels(where: { maturity: "${maturity}" }) {
                id
                maturity
                versions(limit: ${limit}, start: ${start} sort: "created_at:desc") {
                    ${dependencies.retrieveVersionFields}
                }
            }
        }
    }`
    const { apps: [{ channels: [channel] }] } = await submitGraphql<{ apps: RemoteApp<RemoteChannelVersions>[] }>(dependencies, query)
    return channel
}

export const getLocalAppVersion = async (dependencies: Dependencies, name: string) => {
    const changelog = await getLocalAppChangelog(dependencies, -1)
    return changelog.versions.find(version => version.name == name)
}

export const getLatestLocalAppVersion = async (dependencies: Dependencies) => {
    const changelog = await getLocalAppChangelog(dependencies, 1)
    return changelog.versions[0]
}

const getInstalledVersion = ({ app, installedVersionPath }: Dependencies) => fs.readJSON(path.join(installedVersionPath, app))

const setInstalledVersion = async ({ app, installedVersionPath }: Dependencies, version: any) => {
    const appInstalledVersionPath = path.join(installedVersionPath, app)
    await fs.ensureFile(appInstalledVersionPath)
    return fs.writeJSON(appInstalledVersionPath, version)
}

export const setLocalAppChangelog = async (dependencies: Dependencies) => {
    const { changelogPath, app } = dependencies
    const channel = await getInstalledChannel(dependencies)
    const history = await getRemoteAppChangelog(dependencies, channel)
    if (!history) throw new Error(`No history found for app "${app}" channel "${channel}". aborting.`)
    const appChangelogPath = path.join(changelogPath, app)
    await fs.ensureFile(appChangelogPath)
    await fs.writeJSON(appChangelogPath, history)
    return history
}

export const getLocalAppChangelog = async ({ app, changelogPath }: Dependencies, limit = 10, start = 0) => {
    const history = await fs.readJSON(path.join(changelogPath, app)) as RemoteChannelVersions
    if (limit == -1) return history
    return { ...history, versions: history.versions.slice(start, start + limit) }
}

interface App {
    app: string
    vendor: string
}

const getAppNameByVendorApp = ({ vendor, app }: App) => `${vendor}/${app}`
export const getInstalledChannel = async (dependencies: Dependencies) => (await getInstalledVersion(dependencies)).maturity
export const getAppByDockerImage = (dependencies: Dependencies, vendorAppName: App) => getAppFactory({ ...dependencies, app: getAppNameByVendorApp(vendorAppName) })
export const getAppMaturity = async (dependencies: Dependencies, app: App, maturity: VersionMaturity) => ({
    app: getAppByDockerImage(dependencies, app),
    maturity: maturity || await getInstalledChannel({ ...dependencies, app: getAppNameByVendorApp(app) })
})

// used to determine whether to use maturity or version name to determine where to update to
export const getUpdateTargetVersion = async (app: ReturnType<typeof getAppFactory>, targetVersionName: string, targetVersionMaturity: VersionMaturity) => {
    if (!targetVersionName && !targetVersionMaturity) return app.getLatestVersion((await app.getInstalledVersion()).maturity)
    if (!targetVersionName && targetVersionMaturity) return app.getLatestVersion(targetVersionMaturity)
    const targetVersion = await app.getVersion(targetVersionName)
    if (!targetVersion) throw new Error(`Update - Target version ${targetVersionName} does not exist in app-store`)
    return targetVersion
}
