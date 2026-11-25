import { describe, expect, it } from 'vitest'
import { isLegacyTrialServerUrl } from '../legacyServer'

const legacyUrls = [
  'https://sayitapp.site',
  'https://www.sayitapp.site',
  'https://SayItApp.Site',
  'https://sayitapp.site:8443',
  'https://user@sayitapp.site',
  'https://sayitapp.site.',
  'https://sayitapp.site..',
  '//sayitapp.site',
  '///sayitapp.site',
  'http:sayitapp.site',
  'https:sayitapp.site',
  'https:/sayitapp.site',
  'HTTPS:SAYITAPP.SITE',
  'https:sayitapp.site:8443',
  'https:[redacted]@sayitapp.site',
  'https:sayitapp.site.',
  'ftp://sayitapp.site',
]

const otherUrls = [
  'notsayitapp.site',
  'sayitapp.site.evil.example',
  'sayitapp.site',
  'not a url',
  '',
  'https://evil.example/sayitapp.site',
]

describe('isLegacyTrialServerUrl', () => {
  it.each(legacyUrls)('recognizes %s as the former trial server', (url) => {
    expect(isLegacyTrialServerUrl(url)).toBe(true)
  })

  it.each(otherUrls)('does not treat %s as the former trial server', (url) => {
    expect(isLegacyTrialServerUrl(url)).toBe(false)
  })
})
