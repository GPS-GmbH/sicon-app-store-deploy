#!/usr/bin/env node
//@ts-nocheck
import * as getStdin from 'get-stdin'
import * as meow from 'meow'
import { Version } from './app-store'

import { getAppByEnvironment } from '.'

const print = (o: any) => console.log(JSON.stringify(o, 4, null))
const printError = (e: Error | any) => console.error(process.env.DEBUG ? e : e.message)

const siconstore = () => ({
    cli: meow(`
        Usage
        $ siconstore [command]

        Available Commands
        $ siconstore publish
        $ siconstore latest
    `),
    action: (cli: meow.Result<any>) => cli.showHelp(),
})

siconstore.publish = () => ({
    cli: meow(`
        Usage
            $ siconstore publish [app]

        Description
            Uses stdin or flags to publish json to app-store

        Flags
            --maturity      alpha, beta or stable
            --name          name of the release
            --docker-tag     tag of the image
            --changelog     optional changelog. You can use markdown

        Environment variables
            APPSTORE_LOGIN_USERNAME
            APPSTORE_LOGIN_PASSWORD
        
        Example
            echo '{ \\
                "name": "r1.0.2", \\
                "changelog": "### Bug Fixes\\n\\n* **adapters:** fixed write & method rejection", \\
                "dockerTag": "latest", \\
                "maturity": "stable" \\
            }' | siconstore publish a-company/a-container
        
    `),
    action: async (cli: meow.Result<any>) => {
        const [, app] = cli.input
        if (!app || !process.env.APPSTORE_LOGIN_USERNAME || !process.env.APPSTORE_LOGIN_PASSWORD) return cli.showHelp()
        const stdin = await getStdin() || {}
        const version = { ...stdin, ...cli.flags } as Version
        if (!(version && version.name && version.dockerTag && version.maturity)) return cli.showHelp()
        try {
            await getAppByEnvironment(app).publishVersion(version)
        } catch (error) {
            printError(error)
        }
    }
})

siconstore.latest = () => ({
    cli: meow(`
        Usage
            $ siconstore latest [app]

        Description
            Retrieve latest version for an app
        
        Flags
            --maturity, -m   alpha, beta or stable. stable per default
    `, {
        flags: {
            maturity: {
                type: 'string',
                alias: 'm',
                default: 'stable',
            }
        }
    }),
    action: async (cli: meow.Result<any>) => {
        const [, app] = cli.input
        if (!app) return cli.showHelp()
        const { maturity } = cli.flags 
        try {
            print(await getAppByEnvironment(app).getLatestVersion(maturity))
        } catch (error) {
            console.error('retrieval not possible', error)
            process.exit(1)
        }
    }
})

const prop = k => o => o[k]
const pipe = (...fns) => x => [...fns].reduce((acc, f) => f(acc), x)

const getSubcommand = (cliObject: typeof siconstore, level: number) => pipe(
    prop('input'),
    prop(level),
    name => prop(name)(cliObject),
)(prop('cli')(cliObject()))

const cli = (cliObject: typeof siconstore, level = 0) => {
    const { cli: nextCli, action } = cliObject()
    const subCommand = getSubcommand(cliObject, level)
    return subCommand ? 
        cli(subCommand, level + 1) :
        nextCli.flags.help ?
            nextCli.showHelp() :
            action(nextCli)
}

cli(siconstore)