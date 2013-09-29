var auth = new require('./auth');

var consumerKey = auth.consumerKey;
var consumerSecret = auth.consumerSecret;

var OAuth = require('oauth').OAuth
    , oauth = new OAuth(
        "https://api.twitter.com/oauth/request_token",
        "https://api.twitter.com/oauth/access_token",
        consumerKey,
        consumerSecret,
        "1.0",
        "http://noterlive.rphh.org:5000/auth/twitter/callback",
        "HMAC-SHA1"
    );

var twitter = require('twitter-api').createClient();

var express = require("express");
var app = express();
app.configure(function () {
    app.use(express.static(__dirname + '/web'));
    app.use(express.bodyParser());
    app.use(express.cookieParser());

    //app.use(express.session({secret:'refulgenceherringglueeffluent'}));

    app.use(express.cookieSession({secret: 'refulgenceherringglueeffluent'}));
});

app.get('/auth/twitter', function (req, res) {

    oauth.getOAuthRequestToken(function (error, oauth_token, oauth_token_secret, results) {
        if (error) {
            console.log(error);
            res.send("Authentication Failed!");
        }
        else {
            req.session.oauth = {
                token: oauth_token,
                token_secret: oauth_token_secret
            };
            console.log(req.session.oauth);
            res.redirect('https://twitter.com/oauth/authenticate?oauth_token=' + oauth_token)
        }
    });

});

app.get('/auth/twitter/callback', function (req, res, next) {

    if (req.session.oauth) {
        req.session.oauth.verifier = req.query.oauth_verifier;
        var oauth_data = req.session.oauth;

        oauth.getOAuthAccessToken(
            oauth_data.token,
            oauth_data.token_secret,
            oauth_data.verifier,
            function (error, oauth_access_token, oauth_access_token_secret, results) {
                if (error) {
                    console.log(error);
                    res.send("Authentication Failure!");
                }
                else {
                    req.session.oauth.access_token = oauth_access_token;
                    req.session.oauth.access_token_secret = oauth_access_token_secret;
                    console.log(results, req.session.oauth);
                    //res.send("Authenticated <a href='/showuser'>as</a>");
                    twitter.setAuth(
                        consumerKey,
                        consumerSecret,
                        req.session.oauth.access_token,
                        req.session.oauth.access_token_secret
                    );

                    twitter.get('account/verify_credentials', { skip_status: true }, function (user, error, status) {
                        console.log(user ? 'Authenticated as @' + user.screen_name : 'Not authenticated');
                        req.session.user = user;
                        //console.log(req.session);
                        //res.send("Logged in as @"+user.screen_name);
                        res.redirect('/');
                    });
                }
            }
        );
    }
    else {
        res.redirect('/'); // Redirect to login page
    }

});

app.get('/sendtweet', function (req, res, next) {
    console.log("sendtweet: " + req.query.status);
    try {
        twitter.post('statuses/update', {'status': req.query.status}, function (tweet, error, status) {
            console.log(tweet ? 'posted as @' + tweet.user.screen_name : 'Not authenticated');
            res.send(tweet ? "<a href='https://twitter.com/" + tweet.user.screen_name + "/status/" +
                tweet.id_str + "'>" + tweet.text + "</a>" : "<a href='/auth/twitter'>login first</a>");
        });
    } catch (e) {
        res.status(401).send('[{"error":"not logged in"}]');
        return;
    }
});

app.get('/showuser', function (req, res, next) {
    if (req.session.user) {
        res.send("<img src='" + req.session.user.profile_image_url + "'> logged in as @" + req.session.user.screen_name);
    } else {
        res.send("not logged in");
    }
});

app.get('/lookupspeaker', function (req, res, next) {
    console.log('Changing speaker: ' + req.query.handle);
    args = { 'include_entities': 'true', 'screen_name': req.query.handle};
    try {
        twitter.get('users/lookup', args, function (data, error, code) {
            res.send(data ? data[0] : "");
        });
    } catch (e) {
        res.status(401).send('[{"error":"not logged in"}]');
        return;
    }
});

streams = {};
/**
 * Initiate stream for hashtag, uses the <a href="https://dev.twitter.com/docs/api/1.1/post/statuses/filter">Filtered Statuses Stream API</a>.
 */
app.get('/stream', function (req, res, next) {
    console.log("stream: " + req.query.q);

    hashtag = req.query.q.toLowerCase();

    args = {
        'track': req.query.q,
        'stall_warnings': true
    };

    if ('undefined' !== typeof search_last_id[hashtag]) {
        args['since_id'] = search_last_id[hashtag];
    }
    try {
        // Setup cache
        if ('undefined' === typeof streams[hashtag])
            streams[hashtag] = {};
        streams[hashtag][req.session.user.screen_name] = [];


        twitter.stream('statuses/filter', args, function (chunk) {
            var blob = JSON.parse(chunk);

            try {
                if ('undefined' === typeof blob.retweeted_status)
                    if (!blob.protected)
                        for (user in streams[hashtag]) {
                            if ('undefined' !== typeof streams[hashtag][user][streams[hashtag][user].length - 1] && streams[hashtag][user][streams[hashtag][user].length - 1].id == blob.id)
                                continue;
                            streams[hashtag][user].push(blob);
                        }
                    else
                        streams[req.query.q][req.session.user.screen_name].push(blob);

                /*
                 Array.prototype.slice.call(streams[req.query.q]).forEach(function (user, val) {
                 console.log(user +"-"+val);
                 streams[req.query.q][user].push(blob);
                 });
                 */

                if (blob.truncated)
                    console.log("truncated: " + chunk);
                if (blob.protected)
                    console.log("protected: " + chunk);

            } catch (e) {
                twitter.abort();
                console.log("stopped stream: " + hashtag + "\r\n" + e);
            }
        });
    } catch (e) {
        res.status(401).send('[{"error":"not logged in"}]');
        return;
    }

    res.redirect('/poll?q=' + encodeURIComponent(hashtag));
});

app.get('/poll', function (req, res, next) {
    console.log("poll: " + req.query.q + " for @" + req.session.user.screen_name);


    hashtag = req.query.q.toLowerCase();

    if ('undefined' === typeof streams[hashtag] || 'undefined' === typeof streams[hashtag][req.session.user.screen_name]) {
        //res.status(404).send('[{"error":"not found"}]');
        res.redirect('/stream?q=' + encodeURIComponent(hashtag));
        return;
    }
    blob = streams[hashtag][req.session.user.screen_name];
    res.status(200).send(blob);

    streams[hashtag][req.session.user.screen_name] = [];
});

collumn0 = [];
collumn1 = [];
collumn2 = [];

search_last_id = {};

/**
 * Uses the <a href="https://dev.twitter.com/docs/api/1.1/get/search/tweets">Twitter Search API</a> to populate the page
 */
app.get('/search', function (req, res, next) {
    console.log("search: " + req.query.q);

    res.header('Cache-Control', 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0');

    if (req.session.user) {

        args = {
            'q': req.query.q,
            'count': 6
        };

        if ('undefined' !== typeof search_last_id[req.query.q]) {
            args['since_id'] = search_last_id[req.query.q];
        }

        try {
            twitter.get('search/tweets', args, function (data, error, code) {
                collumn0 = [];
                collumn1 = [];
                collumn2 = [];
                if (data == null) {
                    res.send("no data received:" + error);
                    return;
                }

                search_last_id[req.query.q] = data.statuses[data.statuses.length - 1].id;

                status_done = {};
                data.statuses.forEach(function (status, itt) {
                        // FIXME: debug
                        if (itt > 6) return;

                        // ensure no duplicate tweets are shown
                        if (status_done[status.id] === true) return;
                        status_done[status.id] = true;

                        num = itt % 3;

                        date = new Date(status.created_at);
                        twdate = date.toLocaleDateString();

                        tweet = '<div><blockquote class="twitter-tweet" data-conversation="none" data-cards="hidden" width="400"><p>' + status.text + '</p>' +
                            '&mdash; ' + status.user.name + ' (@' + status.user.screen_name + ') <a href="https://twitter.com/' +
                            status.user.screen_name + '/statuses/' + status.id_str + '">' + twdate + '</a></blockquote></div>'

                        switch (num) {
                            case 0:
                                collumn0.push(tweet)
                                break;
                            case 1:
                                collumn1.push(tweet);
                                break;
                            case 2:
                                collumn2.push(tweet);
                                break;
                        }
                    }
                )
                collumn0view = '<div style="float:left; margin:0; width:33%;">' + collumn0.join('') + '</div>'
                collumn1view = '<div style="float:left; margin:0; width:33%;">' + collumn1.join('') + '</div>'
                collumn2view = '<div style="float:left; margin:0; width:33%;">' + collumn2.join('') + '</div>'

                res.send(collumn0view + collumn1view + collumn2view + '<script async src="//platform.twitter.com/widgets.js" charset="utf-8"></script>');
            });
        } catch (e) {
            res.status(401).send("not logged in");
            return;
        }

    } else {
        res.status(401).send("not logged in");
    }
});

/*
 <blockquote class="twitter-tweet"><p><a href="https://twitter.com/davemcclure">@davemcclure</a> enjoy!</p>&mdash; webhat/redhat (@webhat) <a href="https://twitter.com/webhat/statuses/383799410536091648">September 28, 2013</a></blockquote>
 <script async src="//platform.twitter.com/widgets.js" charset="utf-8"></script>
 */

var port = process.env.PORT || 5000;
app.listen(port, function () {
    console.log("Listening on " + port);
});
