const appStore = require('./app-store')
const getApp = app => appStore.getAppFactory({
    app,
    username: process.env.APPSTORE_LOGIN_USERNAME || '',
    password: process.env.APPSTORE_LOGIN_PASSWORD || '',
})

module.exports = {
    getApp,
    ...appStore,
}