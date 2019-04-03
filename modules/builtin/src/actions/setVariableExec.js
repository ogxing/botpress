/**
 * Store data to desired storage based on the time to live expectation. Read the
 * documentation for more details
 *
 * @title Set Variable After evaluating 'value' field. Expect 'value' to be a function.
 * @category Storage
 * @author ogxing
 * @param {string} type - Pick between: user, session, temp, bot
 * @param {string} name - The name of the variable
 * @param {any} value - Set the value of the variable by the result of an anon function. Pass in an anon function.
 */
const setVariableExec = async (type, name, value) => {
  let finalValue = "";
  try {
    finalValue = eval(value);
  }
  catch (err) {
    finalValue = value;
  }

  if (type === 'bot') {
    const original = await bp.kvs.get(event.botId, 'global')
    await bp.kvs.set(event.botId, 'global', { ...original, [name]: finalValue })
  } else {
    event.state[type][name] = finalValue !== 'null' ? finalValue : undefined
  }
}

return setVariableExec(args.type, args.name, args.value)
