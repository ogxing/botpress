import React, { Component } from 'react'
import AutoComplete from 'react-autocomplete'
import _ from 'lodash'

class BPSense extends Component {
  constructor(props) {
    super(props)

    const root = Object.keys(props)[0]
    this.state = {
      root,
      value: '',
      items: [{ label: root }]
    }
  }

  handleOnChange = e => {
    debugger
    let value = e.target.value
    let items = this.state.items

    const triggerIndex = value.indexOf('{{')
    const triggerEndIndex = value.indexOf('}}')

    // Trigger templating
    if (triggerIndex > -1) {
      const templateIndex = triggerIndex + 2

      // Escape templating
      if (triggerEndIndex > -1 && value.length === triggerEndIndex - 1) {
        return
      }

      // Trigger autocomplete
      if (value[value.length - 1] === '.') {
        let properties = []
        const obj = this.props[this.state.root]
        const template = value.slice(templateIndex)

        if (template === this.state.root + '.') {
          // Root element
          properties = Object.keys(obj)
        } else {
          let props = template.split('.')
          props.splice(0, 1) // Remove root element
          props.splice(props.length - 1, 1) // Remove empty string from split
          const args = props.join('.')
          properties = Object.keys(_.get(obj, args, {}))
        }

        items = properties.map(p => {
          return { label: p }
        })
      }
    }

    this.props.onChange && this.props.onChange(value)
    this.setState({ value, items })
  }

  handleOnSelect = value => {
    this.setState({ value: this.state.value + value })
  }

  render() {
    return (
      <AutoComplete
        getItemValue={item => item.label}
        items={this.state.items}
        renderItem={(item, isHighlighted) => (
          <div style={{ background: isHighlighted ? 'lightgray' : 'white' }}>{item.label}</div>
        )}
        value={this.state.value}
        onChange={this.handleOnChange}
        onSelect={this.handleOnSelect}
      />
    )
  }
}

module.exports = BPSense
