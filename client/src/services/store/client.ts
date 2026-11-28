import * as bridge from '../bridge'

// Private bridge accessor shared by the store modules; never re-exported by the public barrel.
export const api = () => bridge
