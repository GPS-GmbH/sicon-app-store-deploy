export * from './app-store'
import { getAppFactory } from './app-store'
export const getAppByEnvironment = (app: string) => getAppFactory({
    app,
    username: process.env.APPSTORE_LOGIN_USERNAME || '',
    password: process.env.APPSTORE_LOGIN_PASSWORD || '',
    // not relevant for deploy
    installedVersionPath: '',
    changelogPath: '',
})