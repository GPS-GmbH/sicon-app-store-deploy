const getStdin = require('get-stdin')
const Strapi = require('strapi-sdk-javascript')
const strapi = new Strapi.default('https://app-store-api.exa.sicon.io')

function hasVersionInfo(text) {
    if (text.includes('There are no relevant changes, so no new version is released')) throw new Error(`Can't get versioning info from a non fix or feature build. \nUsing text: \n${text}`)
}

function getMaturityLevelFromTag(tag = 'm') {
    const maturityLevels = {
        m: { maturity: 'alpha', dockerTag: 'master'},
        b: { maturity: 'beta', dockerTag: 'beta'},
        r: { maturity: 'stable', dockerTag: 'release'},
    }
    return maturityLevels[tag]
}

const getMaturityLevelFromName = name => getMaturityLevelFromTag(name.slice(0, 1))

function getLocalVersionInfo(text) {
    hasVersionInfo(text)
    const [, json] = text.match(/JSON-START::([\w\W\s\n]*?)::JSON-END/m)
    const version = JSON.parse(json.replace(/\n/g, '\\n'))
    const maturity = getMaturityLevelFromName(version.name)
    return {
        ...version,
        ...maturity,
    }
}

function getDryRunVersionInfo(text) {
    const [, changelog] = text.match(/Release note for .*\n([\w\n\s\W]*)/m)
    const [, name] = text.match(/\.\.\.([\w.]+)\)/m)
    const maturity = getMaturityLevelFromName(name)
    return {
        changelog,
        name,
        created_at: new Date(),
        ...maturity,
    }
}

function getLocalNonReleaseVersionName(text) {
    const [, name] = text.match(/Found git tag ([\w.]*?) /m)
    return name
}

async function getVersionInfo(text) {
    try {
        return await getDryRunVersionInfo(text)
    } catch (error) {
        try {
            const app = await getRemoteAppVersion(APP, getLocalNonReleaseVersionName(text))
            return {
                ...app.channels[0].versions[0],
                maturity: app.channels[0].maturity
            }
        } catch (error) {
            console.error(error)
        }
    }
}

async function printDryRunVersionFromStdIn() {
    const stdin = await getStdin()
    const version = await getVersionInfo(stdin)
    console.log(JSON.stringify(version, null, 4))
}

async function publishVersionFromStdIn() {
    const stdin = await getStdin()
    console.log('DEBUG - STDIN')
    console.log(stdin)
    try {
        const info = getLocalVersionInfo(stdin)
        return publish(info)
    } catch (error) {
        console.log(error)
    }
    console.log(stdin)
}

const USERNAME = process.env.APPSTORE_LOGIN_USERNAME || ''
const PASSWORD = process.env.APPSTORE_LOGIN_PASSWORD || ''
const APP = process.env.APPSTORE_DOCKERIMAGE || ''

async function login() {
    return await strapi.login(USERNAME, PASSWORD)
}

async function getRemoteAppVersion(app, version) {
    const query = `{
        apps(where:{ dockerImage: "${app}", author: { username: "${USERNAME}" } }) {
            id
            channels(where: { maturity: "${getMaturityLevelFromName(version).maturity}" }) {
                id
                maturity
                versions(limit: 1, sort: "created_at:desc", where: { name: "${version}" }) {
                    name
                    changelog
                    created_at
                    dockerTag
                }
            }
        }
    }`
    await login()
    const { data: { data: { apps } } } = await strapi.axios.post('/graphql', { query })
    return apps.length && apps[0]
}

async function publish(version) {
    const app = await getRemoteAppVersion(APP, version.name)
    const channel = app.channels[0].id
    const versionExists = app.channels[0].versions.length
    if (versionExists) throw new Error(`can't republish an existing version ${version.name}`)
    await login()
    return strapi.createEntry('versions', { ...version, channel })
}

module.exports = {
    getVersionInfo,
    getDryRunVersionInfo,
    printDryRunVersionFromStdIn,
    publish,
    publishVersionFromStdIn
}