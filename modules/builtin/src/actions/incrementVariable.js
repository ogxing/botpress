/**
 * Store data to desired storage based on the time to live expectation. Read the
 * documentation for more details
 * Copy it to botpress\out\bp\data\global\actions\builtin to work.
 *
 * @title Increment Variable
 * @category Storage
 * @author ogxing.
 * @param {string} type - Pick between: user, session, temp, bot
 * @param {string} name - The name of the variable. if undefined, will be set to 0.
 */
const incrementVariable = async (type, name) => {
    let lastValue = event.state[type][name]
    if ((typeof lastValue !== 'undefined')) {
        lastValue = Number(lastValue);
        event.state[type][name] = lastValue + 1;
    }
    else {
        event.state[type][name] = 0;
    }
}

return incrementVariable(args.type, args.name)
