/**
 * Store data to desired storage based on the time to live expectation. Read the
 * documentation for more details
 * Copy it to botpress\out\bp\data\global\actions\builtin to work.
 *
 * @title Perform http request
 * @category Utility
 * @author ogxing.
 * @param {string} url - Target url.
 * @param {string} method - Pick between: get, post
 * @param {string} json - JSON data to pass to method
 * @param {string} type - Pick between: user, session, temp, bot
 * @param {string} name - The name of the variable. if undefined, will be set to 0.
 */
const httpReq = async (url, method, json, type, name) => {
    const axios = require('axios');

    // Convert all escaped character back to original.
    let parsedJson = JSON.parse(json);
    Object.keys(parsedJson).forEach(function (key) {
        let val = parsedJson[key];
        if (typeof val === "string") {
            parsedJson[key] = val.replace(/&#x2F;/g, "/");
        }
    });

    if (method.toLowerCase() == "post") {
        const res = await axios.post(url, parsedJson);
        console.log(res.data);
        event.state[type][name] = res.data;
    }
    else if (method.toLowerCase() == "get") {
        const res = await axios.get(url, { params: parsedJson });
        event.state[type][name] = res;
    }
}

return httpReq(args.url, args.method, args.json, args.type, args.name)
