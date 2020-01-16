import test from 'ava'
const version = require('../lib/app-store')

test('get docker tag by vendor and app tuple', t => {
    const { app } = version.getAppByDockerImage({}, { vendor: 'sicon', app: 'backend' })
    t.is(app, 'sicon/backend')
})