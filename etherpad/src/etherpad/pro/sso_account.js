import ("etherpad.control.pro.account_control");
import ("cache_utils");
import ("dateutils");
import("execution");

import ("fileutils");
import ("etherpad.globals");
import ("etherpad.helpers");
import ("etherpad.log");
import ("etherpad.pad.pad_security");
import ("netutils");
import ("etherpad.pro.pro_accounts");
import ("etherpad.pro.pro_tokens");
import ("etherpad.pro.domains");
import ("etherpad.sessions");
import ("etherpad.utils");
import ("s3");
import ("stringutils");
import ("sync");
import ("underscore._");
jimport("java.util.concurrent.ConcurrentHashMap");


//----------------------------------------------------------------
// links a user's account in another service via OAuth2
//----------------------------------------------------------------

// The default set of permissions to ask the user for.
var DEFAULT_SCOPES = [
  "email"
];

var CLIENT_DETAILS;

//----------------------------------------------------------------
// callbacks (Sends the user here if they approve linkage)
//----------------------------------------------------------------

// Sign in (set the session account)
function handleLoginCallback() {
  var userInfo;

  var subDomain = request.cookies['SUBDOMAIN_OAUTH'];
  
  // Clear the nonce
  deleteOAuthSessionVars();
  
  if (request.params.code) {
    try {
      var authorization = acquireServiceAuthorizationToken(request.params.code);
      if (authorization) {
        userInfo = currentUserInfo(authorization.access_token);
      }
    } catch (e) {
      log.logException(e);
      account_control.setSigninNotice("Failed to connect. Please try again, or contact us at helpdesk@stek.io");
      response.redirect("/ep/account/sign-in");
    }
  }
  
  if (userInfo) {
    // Provision for mixed case emails
    var accountEmail = userInfo.email.toLowerCase();

    if (accountEmail) {
      var emailAddress = accountEmail;
      log.custom("custom-service", "Trying to sign in as " + emailAddress + " " +accountEmail.length);
      var signedInAccount = account_control.completeServiceSignIn(emailAddress, userInfo.name, "/ep/account/sign-in");

      
      if (!signedInAccount) {
        response.redirect("/");
      }

      if (typeof authorization.expires_in === 'undefined') {
        // Default to one year expiry time for the access token
        authorization.expires_in = 31556926;
      }

      saveAuthorization(authorization, signedInAccount.id);
      sessions.getSession().isOauthServiceConnected = true;

      var url = request.scheme + '://' + subDomain + '.' + helpers.canonicalDomain();
      response.redirect(url);

    }
  }

  response.redirect("/");
}



//----------------------------------------------------------------
// api
//----------------------------------------------------------------

function currentUserInfo(optOverrideToken) {
  var token = optOverrideToken || pro_tokens.getFreshToken(pro_tokens.CUSTOM_OAUTH2_SERVICE_TOKEN).token;

  return JSON.parse(netutils.urlGet(appjet.config.customClientOAuthEndpoint + "/oauth2/userinfo/", {}/*params*/, {
    'Authorization': "Bearer " + token,
  }).content);
}

//----------------------------------------------------------------
// functions
//----------------------------------------------------------------

/** Ensures we inject the nonce into state */
function serviceOAuth2URLForLogin(optIdentity) {
  return serviceOAuth2URL(DEFAULT_SCOPES, optIdentity, generateStateDict());
}

function serviceOAuth2URL(scopes, optIdentity, optState) {

  var subDomain = request.host.replace('.' + helpers.canonicalDomain(), '');

  if (!subDomain) { // on home page
    // Do something @@@@@@@@@@@@@@@@
  } else {
    response.setCookie({
      name: 'SUBDOMAIN_OAUTH',
      value: subDomain,
      path: "/",
      domain: sessions.getScopedDomain(),
      secure: appjet.config.useHttpsUrls,
      httpOnly: true /* disallow client js access */
    });
  }
  
  scopes = scopes || DEFAULT_SCOPES;
  var params = {
    client_id: clientId(),
    redirect_uri: callbackUri(),
    response_type: "code",
    scope: scopes.join(" ")
  };


  if (optIdentity) {
    params = _.extend(params, {
      login_hint: optIdentity,
      prompt: 'none',
    })
  } else {
    // Ideally we should only force approval if our refresh token stops working
    // if (optForceApprovalPrompt) {
    params = _.extend(params, {
      response_type: "code",
    })
    // }

  }

  return clientServiceDetails().auth_uri + "?" + utils.encodeUrlParams(params);
}


function acquireServiceAuthorizationToken(code) {

  var result = netutils.urlPost(clientServiceDetails().token_uri, {
    code: String(code),
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: callbackUri(),
    grant_type: "authorization_code"
  }, null/*options*/, true /*acceptErrorCodes*/);

  if (result) {
    return JSON.parse(result.content);
  }
}

function authorizeViaRefreshToken(refreshToken) {
  var result = netutils.urlPost(clientServiceDetails().token_uri, {
    refresh_token: String(refreshToken),
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: callbackUri(),
    grant_type: "refresh_token",
  }, null, true);

  if (result) {
    return JSON.parse(result.content);
  }
}

function refreshToken(token, accountId) {
  if (token.tokenExtra) {
    var newAuthorization = authorizeViaRefreshToken(token.tokenExtra);
    if (newAuthorization) {
      saveAuthorization(newAuthorization, accountId);
      token.token = newAuthorization.access_token;
      token.tokenExtra = newAuthorization.tokenExtra;
      token.expirationDate = dateutils.addSecondsToDate(new Date(), newAuthorization.expires_in);
      log.custom("custom-service-oauth2", "Refreshed token for user " + accountId);
    }
  } else {
    throw Error("Can't refresh token; it doesn't have an associated refreshToken.");
  }
}

function saveAuthorization(authorization, accountId) {

  pro_tokens.setToken(
    accountId,
    pro_tokens.CUSTOM_OAUTH2_SERVICE_TOKEN,
    authorization.access_token,
    authorization.refresh_token,
    dateutils.addSecondsToDate(new Date(), authorization.expires_in)
  );
}

function callbackUri() {
  // Address of `render_callback()`
  // N.B.: This must be the same between /auth and /token calls.
  return utils.absoluteURL("/ep/account/openid", {}, "" /*force superdomain*/);
}

function clientId() {
  return clientServiceDetails().client_id;
}

function clientSecret() {
  return clientServiceDetails().client_secret;
}

function clientServiceDetails() {
  return {
    token_uri: appjet.config.customClientOAuthEndpoint + "/oauth2/token/",
    auth_uri: appjet.config.customClientOAuthEndpoint + "/oauth2/authorize/",
    client_secret: appjet.config.serviceClientSecret,
    client_id: appjet.config.serviceClientId
  };
}

var TWO_DAYS = 1000*60*60*24*2;

function _getCache(cacheName) {
  // this function is normally fast, only slow when cache
  // needs to be created for the first time
  var cache = appjet.cache[cacheName];
  if (cache) {
    return cache;
  }
  else {
    // initialize in a synchronized block (double-checked locking);
    // uses same lock as cache_utils.syncedWithCache would use.
    sync.doWithStringLock("cache/"+cacheName, function() {
      if (! appjet.cache[cacheName]) {
        // values expire after 2 days
        appjet.cache[cacheName] =
          new net.appjet.common.util.ExpiringMapping(TWO_DAYS);
      }
    });
    return appjet.cache[cacheName];
  }
}

serverhandlers.tasks.loadPhoto = function(account, imageUrl) {
  var photo = netutils.urlGet(imageUrl);
  if (photo) {
    s3.put("hackpad-profile-photos", account.email, photo.content, true, photo.contentType);
    pro_accounts.setAccountHasPhotoByEmail(account.id);
  }
}

function onStartup() {
}

/// oauth utils
function setOAuthSessionVars() {
  var session = sessions.getSession();
  // A nonce is set for verification.
  session.oAuth2Nonce = session.oAuth2Nonce || stringutils.randomString(10);
}

function deleteOAuthSessionVars() {
  delete sessions.getSession().oAuth2Nonce;
}

/** Generates a new state dict for auth. */
function generateStateDict() {
  setOAuthSessionVars();

  var state = {
    nonce: sessions.getSession().oAuth2Nonce,
    shortContUrl: shortContinuationURL(),
  };

  if (!domains.isPrimaryDomainRequest()) {
    state['subDomain'] = domains.getRequestDomainRecord().subDomain;
  }

  return state;
}

/** Validates the state the server set us */
function validateReceivedState(state) {
  if (state.nonce != sessions.getSession().oAuth2Nonce) {
    log.warn("Nonce mis-match");
    if (state.shortContUrl && state.shortContUrl[0] == '/') {
      // try again if we have a short relative url we're trying to reach
      // who makes refreshing work when being granted access to a team / validating email
      response.redirect(state.shortContUrl);
    }
    response.redirect('/')
  }
}


/**
 * Generate a short pad url from the optional cont if provided and is a pad url.
 *
 * This make refreshing the auth page work reliably, but avoids us having a state in the URL
 * that's too long.
 */
function shortContinuationURL() {
  var cont = request.params.cont || request.url || "/";
  cont = pad_security.sanitizeContUrl(cont);

  // Shorten pad urls for the redirect
  var longPadUrlMatch = cont.match(/(https?\:\/\/[^\/]+\/)[^\/]+-([a-zA-Z0-9]{11})(\?.*token=([^&]+))?/);
  if (longPadUrlMatch) {
    cont = longPadUrlMatch[1] + longPadUrlMatch[2];
    if (longPadUrlMatch.length == 5) {
      cont += "?token=" + longPadUrlMatch[4];
    }
  }
  return cont;

}
