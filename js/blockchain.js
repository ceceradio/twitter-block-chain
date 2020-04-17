var usersBlocked = 0,
    usersFound = 0,
    usersAlreadyBlocked = 0,
    usersSkipped = 0,
    totalCount = 0,
    errors = 0;
var batchBlockCount = 5;
var finderRunning = false,
    blockerRunning = false;
var blockQueue = new Queue();
var currentProfileName = "";
var connectionType = "following";
var queuedStorage = {};
var protectedUsers = {};
var userExport = {};
var mode = 'block'; // [block, export, import];

var storage = new ExtensionStorage();
const mobileTwitterCSRFCookieKey = 'ct0';
const rateLimitWait = 100;
const otherWait = 10;

if (typeof XPCNativeWrapper === 'function') {
    // In Firefox, XHR($.ajax) doesn't send Referer header.
    // see: https://discourse.mozilla.org/t/webextension-xmlhttprequest-issues-no-cookies-or-referrer-solved/11224/9
    $.ajaxSettings.xhr = function () {
        return XPCNativeWrapper(new window.wrappedJSObject.XMLHttpRequest())
    }
}

function resetState() {
    usersBlocked = 0
    usersFound = 0
    usersAlreadyBlocked = 0
    usersSkipped = 0
    totalCount = 0
    errors = 0
    blockQueue = new Queue()
}

function isOnTheRightPage() {
    if (!isOnMobileTwitter()) {
        return $(".ProfileNav-item--followers.is-active, .ProfileNav-item--following.is-active").length > 0;
    } else {
        return api.getProfileUsername();
    }
}

browser.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (typeof request.blockChainStart !== "undefined") {
        if (isOnTheRightPage() || request.blockChainStart === 'import') {
            sendResponse({
                ack: true
            });
            if (request.blockChainStart === 'block') {
                startBlockChain();
            } else if (request.blockChainStart === 'export') {
                startExportChain();
            } else if (request.blockChainStart === 'import') {
                startImportChain();
            }
        } else {
            sendResponse({
                error: true,
                error_description: 'Navigate to a twitter following or followers page.'
            });
        }
    }
});


class WebTwitter {
    getProfileUsername() {
        return $(".ProfileSidebar .ProfileHeaderCard .ProfileHeaderCard-screenname a span").text();
    }

    startAccountFinder() {
        finderRunning = true;
        var profileUsername = currentProfileName;
        var position = $(".GridTimeline-items").data('min-position');
        var positionKeyname = "position-" + profileUsername;
        var lastRequestTime = Date.now();
        var apiPart = window.location.href.split("/");
        apiPart = apiPart[apiPart.length - 1];

        function _processData(data) {
            var scratch_usersSkipped = 0;
            var scratch_usersAlreadyBlocked = 0;
            var scratch_usersFound = 0;
            data.items_html = data.items_html.replace(/src\=\".+\"/g, '').replace(/url\(.+\)/g, '');
            var items_html = $(data.items_html);
            var users = $.map(items_html.find('.ProfileCard'), function (element) {
                element = $(element);
                var username = element.data('screen-name');
                var id = element.data('user-id');
                if ($(element).find('.user-actions.following').length > 0 || username in protectedUsers) {
                    scratch_usersSkipped++;
                    return null;
                }
                scratch_usersFound++;
                // only skip already blocked users in block mode
                if (mode === 'block' && $(element).find('.user-actions.blocked').length > 0) {
                    scratch_usersAlreadyBlocked++;
                    return null;
                }
                return {
                    username: username,
                    id: id
                };
            });
            usersFound += scratch_usersFound;
            usersSkipped += scratch_usersSkipped;
            usersAlreadyBlocked += scratch_usersAlreadyBlocked;
            // @todo change to UpdateDialog()
            UpdateDialog()
            users = users.filter(function (username) {
                return username != null
            });
            users.forEach(function (user) {
                blockQueue.enqueue({
                    name: user.username,
                    id: user.id
                });
            });
            if (data.has_more_items && finderRunning) {
                position = data.min_position;
                var delay = 500;
                delay -= (Date.now() - lastRequestTime);
                delay = Math.max(1, delay);
                setTimeout(_getData, delay); // 500ms to reduce rate limiting
            } else {
                finderRunning = false;
                storage.setLocal({
                    positionKeyname: null
                }, function () {
                })
                totalCount = usersFound + usersSkipped;
                $("#blockchain-dialog .totalCount").text(totalCount);
            }
        }

        function _getData() {
            if (!finderRunning) return false;
            lastRequestTime = Date.now();
            $.ajax({
                url: 'https://twitter.com/' + profileUsername + '/' + apiPart + '/users?include_available_features=1&include_entities=1&reset_error_state=false&max_position=' + position,
                method: 'GET',
                dataType: 'json'
            })
                .done(_processData)
                .fail(_error);
        }

        function _error(data) {
            //console.log(data);
            finderRunning = false;
            storage.setLocal({
                positionKeyname: position
            }, function () {
                alert('There was an error retrieving more accounts. Please refresh the page and try again.');
                if (callback) callback();
            });
        }

        storage.getLocal(positionKeyname, function (data) {
            if (typeof data === "string") position = data;
            _processData({
                items_html: $(".GridTimeline-items").html(),
                has_more_items: true,
                min_position: position
            });
            $(".GridTimeline-items").hide();
        })

        return Promise.resolve();
    }

    _shouldStopBlocker() {
        return (
            usersBlocked + usersSkipped >= usersFound ||
            (mode === 'import' && usersBlocked + errors >= totalCount && totalCount > 0)
        ) && totalCount > 0 && !finderRunning;
    }

    async startBlocker() {
        blockerRunning = true;
        while (blockerRunning) {
            await sleep(rateLimitWait);
            var user = blockQueue.dequeue();
            if (typeof user !== "undefined") {
                this._doBlock($("#authenticity_token").val(), user.id, user.name);
            } else if (this._shouldStopBlocker()) {
                blockerRunning = false;
                saveBlockingReceipts();
                break;
            }
        }
    }

    async startExporter() {
        blockerRunning = true;
        while (blockerRunning) {
            await sleep(otherWait);
            var user = blockQueue.dequeue();
            if (typeof user !== "undefined") {
                this._doExport(user.id, user.name);
            } else {
                blockerRunning = false;
                break;
            }
        }
    }

    async startImporter(data) {
        var index = 0;
        totalCount = data.users.length;
        $("#blockchain-dialog .totalCount").text(totalCount);
        blockerRunning = true;
        while (blockerRunning) {
            await sleep(rateLimitWait);
            var user = data.users[index];
            if (typeof user !== "undefined") {
                this._doBlock($("#authenticity_token").val(), user.id, user.name);
            }
            index++;
        }
    }

    _doBlock(authenticity_token, user_id, user_name) {
        $.ajax({
            url: "https://twitter.com/i/user/block",
            method: "POST",
            dataType: 'json',
            data: {
                authenticity_token: authenticity_token,
                challenges_passed: false,
                handles_challenges: 1,
                impression_id: "",
                //screen_name: user_name,
                user_id: String(user_id)
            }
        }).done((response) => {
            queuedStorage[user_name] = {
                type: connectionType,
                connection: currentProfileName,
                on: Date.now(),
                id: String(user_id)
            };
        }).fail((xhr, text, err) => {
            errors++;
            UpdateDialog();
        }).always(() => {
            usersBlocked++;
            $("#blockchain-dialog .usersBlocked").text(usersBlocked);
            if (this._shouldStopBlocker()) {
                blockerRunning = false;
                saveBlockingReceipts();
            }
        });
    }

    _doExport(user_id, user_name) {
        userExport.users.push({
            id: user_id,
            name: user_name
        });
        usersBlocked++;
        UpdateDialog();
        if ((usersBlocked === totalCount || usersBlocked === usersFound) && totalCount > 0) {
            blockerRunning();
            showExport();
        }
    }
}

class MobileTwitter {

    constructor() {
        this.cursor = null;

        this.id_chunks = [];

        this.rateLimitResetTimeOfFetchIds = Date.now();

        this.have_ids_all_fetched = false;
    }


    getProfileUsername() {
        return window.location.href.match(/twitter\.com\/(.+?)\/(followers|following)/)[1];
    }

    _getCSRFCookie() {
        return getCookie(mobileTwitterCSRFCookieKey);
    }

    _makeRequest(options) {
        document.cookie = `${mobileTwitterCSRFCookieKey}=${this._getCSRFCookie()};`;
        document.cookie = `auth_token=${getCookie('auth_token')};`;
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                ...options,
                contentScriptQuery: "doRequest",
                auth_token: getCookie('auth_token'),
                CSRFCookie: this._getCSRFCookie()
            }, ({success, response}) => {
                if (success) {
                    resolve(response);
                } else {
                    reject(response);
                }
            });
        });
    }

    async _fetchIDData() {
        if (this.have_ids_all_fetched) {
            return Promise.resolve(false);
        }
        await sleep(this.rateLimitResetTimeOfFetchIds - Date.now())
        if (!finderRunning) return Promise.resolve(false);
        const count = 300;
        let requestType = window.location.href.split("/").pop();
        if (requestType === 'following') {
            requestType = 'friends'
        }
        let url = `${requestType}/ids.json?screen_name=${currentProfileName}&count=${count}&stringify_ids=true`;
        // restore cursor when exist.
        storage.getLocal(['block_cursor'], c => {
            if (!this.cursor) {
                console.log("INFO: " + "restore cursor: " + c.block_cursor[currentProfileName]);
                this.cursor = c.block_cursor[currentProfileName];
            }
        });
        // store cursor before fetch.
        if (this.cursor) {
            storage.setLocal({"block_cursor": {[currentProfileName]: this.cursor}},
                () => {
                    console.log("INFO: " + "current cursor: " + this.cursor);
                });
            url += `&cursor=${this.cursor}`;
        }
        return this._makeRequest({
            url: url,
            method: 'GET'
        }).then(resp => {
            this.rateLimitResetTimeOfFetchIds = this.obtainRateLimitResetTime(resp);
            let jsonData = resp.data;
            if (jsonData.hasOwnProperty('next_cursor_str') && String(jsonData.next_cursor_str) !== "0") {
                this.cursor = jsonData.next_cursor_str;
            } else {
                this.have_ids_all_fetched = true;
                console.log("INFO: all ids have been fetched");
                // clear cursor when all ids fetched.
                storage.setLocal({"block_cursor": {[currentProfileName]: null}},
                    () => {
                        console.log("INFO: " + "current cursor: " + this.cursor);
                    });
            }

            if (jsonData.hasOwnProperty('ids')) {
                // split array of ids into 100 user chunks
                let i = 0;
                while (i * 100 < jsonData.ids.length) {
                    let slice = jsonData.ids.slice(i * 100, i * 100 + 100);
                    this.id_chunks.push(slice.join(","));
                    i++;
                }
            }
        });
    }

    async* _getUserData() {

        if (this.id_chunks.length === 0) {
            finderRunning = false;
            return Promise.resolve(false);
        }

        let rateLimitResetTime = Date.now();

        while (this.id_chunks.length !== 0) {
            let id_chunk = this.id_chunks.pop();
            let url = 'users/lookup.json?include_entities=true&include_blocking=true';
            yield this._makeRequest({
                url: url,
                headers: {
                    'content-type': 'application/x-www-form-urlencoded'
                },
                body: `user_id=${id_chunk}`,
                method: 'POST'
            }).then(
                (resp) => {
                    rateLimitResetTime = this.obtainRateLimitResetTime(resp);
                    return resp.data;
                }
            )
            await sleep(rateLimitResetTime - Date.now() + 5000);
        }
    }

    _processData(users) {
        let scratch_usersFound = 0;
        let scratch_usersSkipped = 0;
        let scratch_usersAlreadyBlocked = 0;
        if (users) {
            var _users = users
                .filter((element) => {
                    if (element.following || element.screen_name in protectedUsers) {
                        scratch_usersSkipped++;
                        return false;
                    }
                    return true;
                })
                .filter((element) => {
                    if (element.blocking) {
                        scratch_usersFound++;
                        scratch_usersAlreadyBlocked++;
                        return false;
                    }
                    return true;
                })
                .filter((element) => {
                    return element.screen_name != null;
                })
                .map((element) => {
                    scratch_usersFound++;
                    return {
                        username: element.screen_name,
                        id: element.id_str
                    };
                });
            usersFound += scratch_usersFound;
            usersSkipped += scratch_usersSkipped;
            usersAlreadyBlocked += scratch_usersAlreadyBlocked;
            UpdateDialog()
            _users.forEach(function (user) {
                blockQueue.enqueue({
                    name: user.username,
                    id: user.id
                });
            });
        } else {
            throw new Error('There was no data returned from the server');
        }
    }

    _error(data) {
        console.log(data);
        finderRunning = false;
        // storage.setLocal({
        //     positionKeyname: null
        // }, function () {
        //     alert('There was an error retrieving more accounts. Please refresh the page and try again.');
        // })
    }

    async* accountFinderGenerator() {
        finderRunning = true;
        const profileUsername = currentProfileName;
        let requestType = window.location.href.split("/").pop();
        if (requestType === 'following') {
            requestType = 'friends'
        }
        let position = $(".GridTimeline-items").data('min-position');

        while (finderRunning) {
            if (this.id_chunks.length === 0) {
                await this._fetchIDData()
            }
            yield await this._getUserData().next()
                .then(resp => {
                    if (!resp || resp.done) {
                        blockerRunning = false;
                        throw new Error("ERROR: get none user data.");
                    }
                    this._processData(resp.value);
                })
                .catch(this._error);
        }
    }

    _shouldStopBlocker() {
        // return ((usersBlocked >= usersFound - usersAlreadyBlocked) && !finderRunning);
        return false;
    }

    _doBlock(user) {
        return this._makeRequest({
            url: `blocks/create.json?user_id=${user.id}&skip_status=true&include_entities=false`,
            method: 'POST'
        }).then((response) => {
            queuedStorage[user.name] = {
                type: connectionType,
                connection: currentProfileName,
                on: Date.now(),
                id: String(user.id)
            };
            return response;
        }).catch(
            () => {
                errors++;
                blockerRunning = false;
                console.log("ERROR: block api error.")
            }).then((resp) => {
            usersBlocked++;
            if (!blockerRunning) {
                totalCount = usersBlocked + usersSkipped + usersAlreadyBlocked;
                saveBlockingReceipts();
            }
            UpdateDialog();
            return resp;
        });
    }

    obtainRateLimitResetTime(resp) {
        try {
            let rateLimitRemaining = resp.__headers__['x-rate-limit-remaining'];
            let rateLimitResetTime = resp.__headers__['x-rate-limit-reset'];
            console.log("blocked user:" + user + "; rateLimitRemaining:" + rateLimitRemaining);
            if (rateLimitRemaining && Number(rateLimitRemaining) <= 1 && rateLimitResetTime) {
                if (Number(rateLimitResetTime) - Date.now() > 1000) {
                    return Number(rateLimitResetTime);
                } else {
                    return Date.now();
                }
            }
        } catch {
            console.log("ERROR: can't read rate limit headers.");
            return Date.now();
        }
    }

    async _doBlockUsers() {
        blockerRunning = true;
        if (blockQueue.getLength() === 0) {
            await this.accountFinderGenerator().next();
        }
        let user = blockQueue.dequeue();
        let blockUserRLResetT = Date.now();
        if (user) {
            this._doBlock(user).then(
                (resp) => {
                    blockUserRLResetT = this.obtainRateLimitResetTime(resp);
                }
            )
        }

        if (!blockerRunning) {
            console.log("block action completed.");
        } else {
            // block api has no ratelimit headers, so sleep at least 4s.
            await sleep(blockUserRLResetT - Date.now() + 4000);
            return this._doBlockUsers();
        }
    }

    async startBlocker() {
        blockerRunning = true;
        await this._doBlockUsers();
    }

    _shouldStopExporter() {
        return ((usersBlocked >= usersFound - usersAlreadyBlocked) && !finderRunning);
    }

    _doExport(user) {
        userExport.users.push({
            id: user.id,
            name: user.name
        });
        usersBlocked++;
        UpdateDialog();
        if (this._shouldStopExporter()) {
            blockerRunning = false;
            showExport();
        }
    }

    async startExporter() {
        blockerRunning = true;
        while (blockerRunning) {
            await sleep(otherWait);
            for (var i = 0; i < batchBlockCount && blockQueue.getLength() > 0; i++) {
                let user = blockQueue.dequeue();
                if (user) {
                    this._doExport(user);
                } else if (this._shouldStopExporter()) {
                    totalCount = usersBlocked + usersSkipped + usersAlreadyBlocked;
                    blockerRunning = false;
                    showExport();
                    UpdateDialog();
                    return
                }
            }
        }
    }

    async startImporter(data) {
        var index = 0;
        totalCount = data.users.length;
        UpdateDialog();
        blockerRunning = true;
        data.users.map(u => blockQueue.enqueue(u));
        await this._doBlockUsers();
    }
}

const api = (isOnMobileTwitter()) ? new MobileTwitter() : new WebTwitter();

function isOnMobileTwitter() {
    return document.getElementById("react-root");
}

function saveBlockingReceipts() {
    if (Object.keys(queuedStorage).length <= 0)
        return;

    storage.getLocal("blockingReceipts", function (items) {
        var receipts = items.blockingReceipts;
        if (typeof receipts === "undefined")
            receipts = {};
        for (var idx in queuedStorage) {
            if (!(idx in receipts)) {
                receipts[idx] = queuedStorage[idx];
            }
        }
        storage.setLocal({
            blockingReceipts: receipts
        }, function () {
            queuedStorage = {};
        });
    });
}

function getProtectedUsers(callback) {
    storage.getSync("protectedUsers", function (items) {
        var users;
        if (!items || !items.protectedUsers)
            users = {};
        else
            users = items.protectedUsers;
        callback(users);
    });
}

function startBlockChain() {
    mode = 'block';
    var result = confirm("Are you sure you want to block all users on this page that you aren't following?");
    if (!result)
        return;
    currentProfileName = api.getProfileUsername();
    resetState();
    showDialog();
    getProtectedUsers(function (items) {
        protectedUsers = items;
        api.startBlocker();
    });
}

function startExportChain() {
    mode = 'export';
    var result = confirm("Are you sure you want to export the usernames of all users on this page?");
    if (!result)
        return;
    currentProfileName = api.getProfileUsername();
    resetState();
    userExport = {
        users: [],
        type: connectionType,
        connection: currentProfileName,
        on: Date.now()
    };
    showDialog();
    getProtectedUsers(function (items) {
        protectedUsers = items;
        api.startAccountFinder();
        api.startExporter();
    });
}

function startImportChain(data) {
    mode = 'import';
    if (typeof data !== 'undefined') {
        var result = confirm("Are you sure you want to block all " + data.users.length + " users in the import?");
        if (!result)
            return;
        currentProfileName = data.connection;
        connection = data.connection;
        connectionType = data.connectionType;
        getProtectedUsers(function (items) {
            protectedUsers = items;
            api.startImporter(data);
        });
    } else {
        showDialog();
    }
}

function showExport() {
    $("#blockchain-dialog .usersFound").parent().hide();
    $("#blockchain-dialog .usersSkipped").parent().hide();
    $("#blockchain-dialog .usersAlreadyBlocked").parent().hide();
    $("#blockchain-dialog .usersBlocked").parent().hide();
    $("#blockchain-dialog .errorCount").parent().hide();
    $("#blockchain-dialog #ImportExport").show().text(JSON.stringify(userExport));
}

function showDialog() {
    $("body").append(
        '<div id="blockchain-dialog" class="modal-container block-or-report-dialog block-selected report-user">' +
        '<div class="close-modal-background-target"></div>' +
        '<div class="modal modal-medium draggable" id="block-or-report-dialog-dialog" role="dialog" aria-labelledby="block-or-report-dialog-header" style="top: 240px; left: 470px;"><div class="js-first-tabstop" tabindex="0"></div>' +
        '<div class="modal-content" role="document">' +
        '<div class="modal-header">' +
        '<h3 class="modal-title report-title" id="blockchain-dialog-header">Twitter Block Chain</h3>' +
        '</div>' +
        '<div class="report-form">' +
        '<p>Found: <span class="usersFound"></span></p>' +
        '<p>Skipped: <span class="usersSkipped"></span></p>' +
        '<p>Already Blocked: <span class="usersAlreadyBlocked"></span></p>' +
        '<p><span class="mode">Blocked</span>: <span class="usersBlocked"></span></p>' +
        '<p>Total: <span class="totalCount"></span></p>' +
        '<p>Errors: <span class="errorCount"></span></p>' +
        '<textarea style="width:90%;height:100%;min-height:300px;display:none;" id="ImportExport"></textarea>' +
        '<div style="display:none;"><button class="btn primary-btn" id="ImportStart">Start Import</button></div>' +
        '</div>' +
        '<div id="report-control" class="modal-body submit-section">' +
        '<div class="clearfix">' +
        '<button id="done" class="btn primary-btn js-close" type="button">Done</button>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '<button type="button" class="modal-btn modal-close js-close" aria-controls="block-or-report-dialog-dialog">' +
        '<span class="Icon Icon--close Icon--medium">' +
        '<span class="visuallyhidden">Close</span>' +
        '</span>' +
        '</button>' +
        '<div class="js-last-tabstop" tabindex="0"></div>' +
        '</div>'
    );
    $("#blockchain-dialog .usersFound").text(usersFound);
    $("#blockchain-dialog .usersSkipped").text(usersSkipped);
    $("#blockchain-dialog .usersAlreadyBlocked").text(usersAlreadyBlocked);
    $("#blockchain-dialog .usersBlocked").text(usersBlocked);
    $("#blockchain-dialog .totalCount").text(totalCount);
    $("#blockchain-dialog .errorCount").text(errors);
    $("#blockchain-dialog .mode").text('Blocked');
    if (mode == 'export') {
        $("#blockchain-dialog .mode").text('Exported');
        $("#blockchain-dialog .usersAlreadyBlocked").parent().hide();
        $("#blockchain-dialog .errorCount").parent().hide();
    }
    if (mode == 'import') {
        $("#blockchain-dialog #ImportStart").parent().show();
        $("#blockchain-dialog #ImportExport").show()

        $("#blockchain-dialog .usersFound").parent().hide();
        $("#blockchain-dialog .usersSkipped").parent().hide();
        $("#blockchain-dialog .usersBlocked").parent().hide();
        $("#blockchain-dialog .totalCount").parent().hide();
        $("#blockchain-dialog .errorCount").parent().hide();

        $("#blockchain-dialog .usersAlreadyBlocked").parent().hide();
    }
    $("#blockchain-dialog #ImportStart").click(function () {
        try {
            var source = JSON.parse($("#ImportExport").val());
            if (source) {
                startImportChain(source);
                $("#ImportExport").text('');
                $("#blockchain-dialog .usersBlocked").parent().show();
                $("#blockchain-dialog .totalCount").parent().show();
                $("#blockchain-dialog .errorCount").parent().show();
                $("#blockchain-dialog #ImportExport").hide();
                $("#blockchain-dialog #ImportStart").parent().hide();
            }
        } catch (e) {
            alert('There was a problem importing this data. It appears to be corrupt.');
            //console.log(e);
        }
    });
    $("#blockchain-dialog").show().find("button.js-close").click(function () {
        totalCount = usersBlocked;
        errors += usersFound - usersBlocked;
        blockerRunning = false;
        finderRunning = false;
        saveBlockingReceipts();
        $("#blockchain-dialog .usersFound").text(usersFound);
        $("#blockchain-dialog .usersSkipped").text(usersSkipped);
        $("#blockchain-dialog .usersAlreadyBlocked").text(usersAlreadyBlocked);
        $("#blockchain-dialog .usersBlocked").text(usersBlocked);
        $("#blockchain-dialog .totalCount").text(totalCount);
        $("#blockchain-dialog .errorCount").text(errors);
        if (mode == 'export') {
            if ($("#blockchain-dialog #ImportExport").is(":visible")) {
                $("#blockchain-dialog").remove();
            } else {
                showExport();
            }
        } else {
            $("#blockchain-dialog").remove();
        }
    });
}

function UpdateDialog() {
    $("#blockchain-dialog .usersAlreadyBlocked").text(usersAlreadyBlocked);
    $("#blockchain-dialog .usersSkipped").text(usersSkipped);
    $("#blockchain-dialog .usersFound").text(usersFound);
    $("#blockchain-dialog .usersBlocked").text(usersBlocked);
    $("#blockchain-dialog .totalCount").text(totalCount);
    $("#blockchain-dialog .errorCount").text(errors);
}

function getCookie(cname) {
    var name = cname + "=";
    var decodedCookie = decodeURIComponent(document.cookie);
    var ca = decodedCookie.split(';');
    for (var i = 0; i < ca.length; i++) {
        var c = ca[i];
        while (c.charAt(0) == ' ') {
            c = c.substring(1);
        }
        if (c.indexOf(name) == 0) {
            return c.substring(name.length, c.length);
        }
    }
    return "";
}

const sleep = (milliseconds) => {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

const tryResumeWorker = () => {
    if (!isOnTheRightPage()) {
        return;
    }
    let cursor_in_storage = null
    currentProfileName = api.getProfileUsername();
    storage.getLocal(['block_cursor'], c => {
        cursor_in_storage = c.block_cursor[currentProfileName];
        if (!cursor_in_storage) {
            return;
        }
        console.log("INFO: " + "resume worker from cursor: " + cursor_in_storage);
        resetState();
        showDialog();
        getProtectedUsers(function (items) {
            protectedUsers = items;
            api.startBlocker();
        });
    });
}

tryResumeWorker();