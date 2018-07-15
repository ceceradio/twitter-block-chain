var usersBlocked = 0,
    usersFound = 0,
    usersAlreadyBlocked = 0,
    usersSkipped = 0,
    totalCount = 0,
    errors = 0;
var batchBlockCount = 5;
var finderRunning = true,
    blockerInterval = false;
var userQueue = new Queue();
var currentProfileName = "";
var connectionType = "following";
var queuedStorage = {};
var protectedUsers = {};
var usersSeenThisRun = {};
var countUsersSeenThisRun = true;
var userExport = {};
var mode = 'block'; // [block, export, import];
var BEARER_TOKEN = `AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`;

var storage = new ExtensionStorage();

if (typeof XPCNativeWrapper === 'function') {
    // In Firefox, XHR($.ajax) doesn't send Referer header.
    // see: https://discourse.mozilla.org/t/webextension-xmlhttprequest-issues-no-cookies-or-referrer-solved/11224/9
    $.ajaxSettings.xhr = function () {
        return XPCNativeWrapper(new window.wrappedJSObject.XMLHttpRequest())
    }
}

browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (typeof request.blockChainStart !== "undefined") {
        const blockChainableHost = (location.hostname === 'twitter.com');
        const blockChainablePath = /^\/[0-9a-z_]+\/(?:following|followers)/.test(location.pathname);
        const protected = $(".ProtectedTimeline").length > 0;
        const blockChainable = (blockChainableHost && blockChainablePath && !protected);
        if (blockChainable || request.blockChainStart == 'import') {
            sendResponse({ack: true});
            if (request.blockChainStart == 'block') {
                startBlockChain();
            }
            else if (request.blockChainStart == 'export') {
                startExportChain();
            }
            else if (request.blockChainStart == 'import') {
                startImportChain();
            }
        }
        else {
            sendResponse({error: true, error_description: 'Navigate to a twitter following or followers page.'});
        }
    }
});

function getProfileUsername() {
    return $(".ProfileSidebar .ProfileHeaderCard .ProfileHeaderCard-screenname a span").text();
}
async function startAccountFinder (callback) {
    function sleep (delay) {
        return new Promise(resolve => window.setTimeout(resolve, delay));
    }
    function error(data) {
        console.log(data);
        finderRunning = false;
        storage.setLocal({positionKeyname: cursor}, function() {
            alert('There was an error retrieving more accounts. Please refresh the page and try again.');
            if (callback) callback();
        });
    }
    let profileUsername = getProfileUsername();
    let positionKeyname = "position-" + profileUsername;
    let cursor = await browser.storage.local.get(positionKeyname).then(store => {
        return store[positionKeyname] || '-1';
    });
    finderRunning = true;
    let lastRequestTime = Date.now();
    let apiPart = window.location.href.split("/");
    apiPart = apiPart[apiPart.length-1];
    if (apiPart === 'following') {
        apiPart = 'friends';
    }
    let url = new URL(`https://api.twitter.com/1.1/${apiPart}/list.json`);
    url.searchParams.set('screen_name', profileUsername);
    url.searchParams.set('count', '200');
    url.searchParams.set('skip_status', 'true');
    url.searchParams.set('include_user_entities', 'false');
    url.searchParams.set('include_blocking', '1');
    let csrfToken = /\bct0=([0-9a-f]{32})\b/.exec(document.cookie);
    if (csrfToken && csrfToken[1]) {
        csrfToken = csrfToken[1];
    }
    while (true) {
        let scratch_usersSkipped = 0;
        let scratch_usersAlreadyBlocked = 0;
        let scratch_usersFound = 0;
        url.searchParams.set('cursor', cursor);
        let response;
        while (true) {
            response = await fetch(url, {
                method: 'get',
                credentials: 'include',
                headers: {
                    authorization: 'Bearer ' + BEARER_TOKEN,
                    'x-csrf-token': csrfToken,
                    'x-twitter-active-user': 'yes',
                    'x-twitter-auth-type': 'OAuth2Session'
                }
            }).catch(err => {
                error(err);
            });
            if (response.ok) {
                break;
            }
            if (response.status === 429) {
                // handle ratelimit
            } else {
                error(response);
                break;
            }
        }
        const json = await response.json();
        let users = json.users.map(function (user) {
            if (user.following || user.screen_name in protectedUsers) {
                scratch_usersSkipped++;
                return null;
            }
            scratch_usersFound++;
            if (mode === 'block' && user.blocking) {
                scratch_usersAlreadyBlocked++;
                return null;
            }
            return {
                username: user.screen_name,
                id: user.id_str
            };
        });
        usersFound+=scratch_usersFound;
        usersSkipped+=scratch_usersSkipped;
        usersAlreadyBlocked+=scratch_usersAlreadyBlocked;
        $("#blockchain-dialog .usersAlreadyBlocked").text(usersAlreadyBlocked);
        $("#blockchain-dialog .usersSkipped").text(usersSkipped);
        $("#blockchain-dialog .usersFound").text(usersFound);
        users = users.filter(function(username){ return username != null });
        users.forEach(function(user) {
            userQueue.enqueue({
                name: user.username,
                id: user.id
            });
        });
        if (json.next_cursor_str !== '0' && finderRunning) {
            cursor = json.next_cursor_str;
            var delay = 500;
            delay -= (Date.now() - lastRequestTime);
            delay = Math.max(1, delay);
            await sleep(delay); // 500ms to reduce rate limiting
        }
        else {
            finderRunning = false;
            storage.setLocal({positionKeyname: null}, function(){})
            totalCount = usersFound + usersSkipped;
            $("#blockchain-dialog .totalCount").text(totalCount);
            if (callback) callback();
            break;
        }
    }
}
function startBlocker() {
    blockerInterval = setInterval(function() {
        for (var i=0;i<batchBlockCount;i++) {
            var user = userQueue.dequeue();
            if (typeof user !== "undefined") {
                doBlock($("#signout-form input.authenticity_token").val(), user.id, user.name);
            }
            else {
                break;
            }
        }
    },40);
}
function startExporter() {
    blockerInterval = setInterval(function() {
        for (var i=0;i<batchBlockCount;i++) {
            var user = userQueue.dequeue();
            if (typeof user !== "undefined") {
                doExport(user.id, user.name);
            }
            else {
                break;
            }
        }
    },40);
}
function startImporter(data) {
    var index = 0;
    totalCount = data.users.length;
    $("#blockchain-dialog .totalCount").text(totalCount);
    blockerInterval = setInterval(function() {
        for(var i = 0; i < batchBlockCount && index < data.users.length; i++) {
            var user = data.users[index];
            if (typeof user !== "undefined") {
                doBlock($("#signout-form input.authenticity_token").val(), user.id, user.name);
            }
            index++;
        }
    });
}
function doBlock(authenticity_token, user_id, user_name, callback) {
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
    }).done(function(response) {
        //console.log(response);
        queuedStorage[user_name] = {type: connectionType, connection: currentProfileName, on: Date.now(), id: String(user_id)};
    }).fail(function(xhr, text, err) {
        errors++;
        $("#blockchain-dialog .errorCount").text(errors);
        //console.log(xhr);
    }).always(function() {
        usersBlocked++;
        $("#blockchain-dialog .usersBlocked").text(usersBlocked);
        if ((
                usersBlocked == totalCount 
                || usersBlocked == usersFound
                || (mode == 'import' && usersBlocked + errors >= totalCount && totalCount > 0)
            ) && totalCount > 0 && !finderRunning) {
            clearInterval(blockerInterval);
            blockerInterval = false;
            saveBlockingReceipts();
        }
    });
}
function doExport(user_id, user_name, callback) {
    userExport.users.push({id: user_id, name: user_name});
    usersBlocked++;
     $("#blockchain-dialog .usersBlocked").text(usersBlocked);
    if ((usersBlocked == totalCount || usersBlocked == usersFound) && totalCount > 0) {
        clearInterval(blockerInterval);
        blockerInterval = false;
        showExport();
    }
}
function saveBlockingReceipts() {
    if (Object.keys(queuedStorage).length <= 0)
        return;
    
    storage.getLocal("blockingReceipts", function(items) {
        var receipts = items.blockingReceipts;
        if (typeof receipts === "undefined")
            receipts = {};
        for (var idx in queuedStorage) {
            if (!(idx in receipts)) {
                receipts[idx] = queuedStorage[idx];
            }
        }
        storage.setLocal({blockingReceipts: receipts},function() {
            queuedStorage = {};
        });
    });
}
function getProtectedUsers(callback) {
    storage.getSync("protectedUsers",function(items) {
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
    currentProfileName = getProfileUsername();
    showDialog();
    getProtectedUsers(function(items) {
        protectedUsers = items;
        usersSeenThisRun = {};
        startAccountFinder();
        startBlocker();
    });
}
function startExportChain() {
    mode = 'export';
    var result = confirm("Are you sure you want to export the usernames of all users on this page?");
    if (!result)
        return;
    currentProfileName = getProfileUsername();
    userExport = {
        users: [],
        type: connectionType, 
        connection: currentProfileName, 
        on: Date.now()
    };
    showDialog();
    getProtectedUsers(function(items) {
        protectedUsers = items;
        usersSeenThisRun = {};
        startAccountFinder();
        startExporter();
    });
}

function startImportChain(data) {
    mode = 'import';
    if (typeof data !== 'undefined') {
        var result = confirm("Are you sure you want to block all "+data.users.length+" users in the import?");
        if (!result)
            return;
        currentProfileName = data.connection;
        connection = data.connection;
        connectionType = data.connectionType;
        getProtectedUsers(function(items) {
            protectedUsers = items;
            startImporter(data);
        });
    }
    else {
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
    usersBlocked = 0;
    usersFound = 0;
    usersAlreadyBlocked = 0;
    usersSkipped = 0;
    totalCount = 0;
    errors = 0;
    saveBlockingReceipts();
    $("#blockchain-dialog .usersFound").text(usersFound);
    $("#blockchain-dialog .usersSkipped").text(usersSkipped);
    $("#blockchain-dialog .usersAlreadyBlocked").text(usersAlreadyBlocked);
    $("#blockchain-dialog .usersBlocked").text(usersBlocked);
    $("#blockchain-dialog .totalCount").text(totalCount);
    $("#blockchain-dialog .errorCount").text(errors);        
    $("body").append(
'<div id="blockchain-dialog" class="modal-container block-or-report-dialog block-selected report-user">'+
    '<div class="close-modal-background-target"></div>'+
    '<div class="modal modal-medium draggable" id="block-or-report-dialog-dialog" role="dialog" aria-labelledby="block-or-report-dialog-header" style="top: 240px; left: 470px;"><div class="js-first-tabstop" tabindex="0"></div>'+
    '<div class="modal-content" role="document">'+
        '<div class="modal-header">'+
            '<h3 class="modal-title report-title" id="blockchain-dialog-header">Twitter Block Chain</h3>'+
        '</div>'+
        '<div class="report-form">'+
            '<p>Found: <span class="usersFound"></span></p>'+
            '<p>Skipped: <span class="usersSkipped"></span></p>'+
            '<p>Already Blocked: <span class="usersAlreadyBlocked"></span></p>'+
            '<p><span class="mode">Blocked</span>: <span class="usersBlocked"></span></p>'+
            '<p>Total: <span class="totalCount"></span></p>'+
            '<p>Errors: <span class="errorCount"></span></p>'+
            '<textarea style="width:90%;height:100%;min-height:300px;display:none;" id="ImportExport"></textarea>'+
            '<div style="display:none;"><button class="btn primary-btn" id="ImportStart">Start Import</button></div>'+
        '</div>'+
        '<div id="report-control" class="modal-body submit-section">'+
            '<div class="clearfix">'+
                '<button id="done" class="btn primary-btn js-close" type="button">Done</button>'+
            '</div>'+
        '</div>'+
    '</div>'+
    '<button type="button" class="modal-btn modal-close js-close" aria-controls="block-or-report-dialog-dialog">'+
        '<span class="Icon Icon--close Icon--medium">'+
            '<span class="visuallyhidden">Close</span>'+
        '</span>'+
    '</button>'+
    '<div class="js-last-tabstop" tabindex="0"></div>'+
'</div>'
    );
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
    $("#blockchain-dialog #ImportStart").click(function() {
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
        }
        catch(e) {
            alert('There was a problem importing this data. It appears to be corrupt.');
            console.log(e);
        }
    });
    $("#blockchain-dialog").show().find("button.js-close").click(function() {
        totalCount = usersBlocked;
        errors += usersFound-usersBlocked;
        clearInterval(blockerInterval);
        blockerInterval = false;
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
                $("#blockchain-dialog").hide();
            }
            else {
                showExport();
            }
        }
        else {
            $("#blockchain-dialog").hide();
        }
    });
}
