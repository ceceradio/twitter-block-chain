const runtimeid = chrome.runtime.id;
const mobileTwitterBearerToken = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
chrome.webRequest.onBeforeSendHeaders.addListener(
    function (details) {
        //details holds all request information. 
        for (var i = 0; i < details.requestHeaders.length; ++i) {
            //Find and change the particular header.
            if (details.requestHeaders[i].name === 'Origin' && details.requestHeaders[i].value == 'chrome-extension://' + runtimeid) {
                details.requestHeaders[i].value = "https://twitter.com";
                break;
            }
        }
        return { requestHeaders: details.requestHeaders };
    },
    { urls: ['https://twitter.com/i/user/block'] },
    ['blocking', 'requestHeaders']
);

function _xhr(obj){
    return new Promise((resolve, reject) => {
        let xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        xhr.open(obj.method || "GET", obj.url);
        if (obj.headers) {
            Object.keys(obj.headers).forEach(key => {
                xhr.setRequestHeader(key, obj.headers[key]);
            });
        }
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 400) {
                // Get the raw header string
                var headers = xhr.getAllResponseHeaders();

                // Convert the header string into an array
                // of individual headers
                var arr = headers.trim().split(/[\r\n]+/);

                // Create a map of header names to values
                var headerMap = {};
                arr.forEach(function (line) {
                    var parts = line.split(': ');
                    var header = parts.shift();
                    var value = parts.join(': ');
                    headerMap[header] = value;
                });
                rsp = JSON.parse(xhr.response);
                Object.assign(rsp, {"__headers": headerMap, "__status": xhr.status})
                resolve(rsp);
            } else {
                reject(xhr.statusText);
            }
        };
        xhr.onerror = () => reject(xhr.statusText);
        xhr.send(obj.body);
    });
}

function _makeRequest(obj) {
    const addtlHeaders = {
        authorization: mobileTwitterBearerToken,
        'x-csrf-token': obj.CSRFCookie,
    };
    if (obj.headers) {
        Object.assign(obj.headers, addtlHeaders);
    } else {
        obj.headers = addtlHeaders;
    }
    // return fetch(
    //     obj.url, 
    //     {
    //         credentials: 'include',
    //         method: obj.method || "GET",
    //         headers: {
    //             ...obj.headers,
    //             "Access-Control-Expose-Headers": "x-rate-limit-limit, x-rate-limit-remaining, x-rate-limit-reset",
    //             "Access-Control-Allow-Headers": "x-rate-limit-limit, x-rate-limit-remaining, x-rate-limit-reset"
    //         },
    //         body: obj.body
    //     }
    // )
    return _xhr(obj).then((response) => {
        if (response.__status >= 200 && response.__status < 300) {
            console.log(response);
            return response;
        }
        else {
            throw new Error(response.__status);
        }
    })
}
// request.user_id
// request.CSRFCookie
chrome.runtime.onMessage.addListener(
    function (request, sender, sendResponse) {
        if (request.contentScriptQuery == "doRequest") {
            _makeRequest({
                ...request,
                url: 'https://api.twitter.com/1.1/' + request.url,
            })
            .then((response) => sendResponse({success: true, response: response}))
            .catch((response) => sendResponse({success: false, response: response}))
            return true;  // Will respond asynchronously.
        }
    }
);
