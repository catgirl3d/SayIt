import { createElement, type ChangeEvent, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Slider } from '../slider'

describe('slider', () => {
  const props = { value: 4.5, min: 3, max: 6, step: 0.5, onChange: () => undefined, labelledBy: 'caption-length', valueText: '4.5 s' }

  it('renders a labelled native range with its bounds and current value', () => {
    const markup = renderToStaticMarkup(createElement(Slider, props))

    expect(markup).toContain('type="range"')
    expect(markup).toContain('min="3"')
    expect(markup).toContain('max="6"')
    expect(markup).toContain('step="0.5"')
    expect(markup).toContain('value="4.5"')
    expect(markup).toContain('aria-labelledby="caption-length"')
    expect(markup).toContain('aria-valuetext="4.5 s"')
    expect(markup.includes('disabled=""')).toBe(false)
  })

  it('can be disabled', () => {
    expect(renderToStaticMarkup(createElement(Slider, { ...props, disabled: true }))).toContain('disabled=""')
  })

  it('reports the new value as a number, not the input string', () => {
    const onChange = vi.fn()
    const element = Slider({ ...props, onChange }) as ReactElement<{ onChange: (event: ChangeEvent<HTMLInputElement>) => void }>
    element.props.onChange({ target: { value: '5.5' } } as ChangeEvent<HTMLInputElement>)

    expect(onChange).toHaveBeenCalledWith(5.5)
  })
})
