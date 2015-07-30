# Introduction #

node-xmpp-bosh installation can be really hard without knowledge of the UNIX shell and associated commands. In this help section, we shall provide instructions for a step-by-step installation of node-xmpp-bosh on Debian and Debian-based systems, like Ubuntu.

# node.js installation #

node.js installation is pretty slow, because it involves compiling it. On some Debian systems, the _nodejs_ package is available in the official repository, so that you can switch this step.

Firstly, we install the dependencies:

`apt-get install libssl-dev python subversion git git-core libexpat1 libexpat1-dev`

Then, we get nodejs v0.4.x (x >= 2):

`wget http://nodejs.org/dist/node-v0.4.7.tar.gz`

`tar -zxvf node-v0.4.7.tar.gz`

`cd ./node-v0.4.7`

Finally, we launch the compilation (can take some minutes):

`./configure --prefix=/usr; make; make install`

Note: configure may tell you to install some missing packages if the required compilation tools are not present on the system.

# Installation of External Modules #

node-xmpp-bosh depends on external node.js modules. These module dependencies may change with future node-xmpp-bosh versions, so that you will need to manually update them by checking the "dependencies" section in the "package.json" file of the version that you are using.

Alternatively, you may completely leave the dependency bits to [npm](http://npmjs.org/) and follow the installation instructions in [INSTALL.TXT](http://code.google.com/p/node-xmpp-bosh/source/browse/trunk/INSTALL.TXT)

First, we create the required folders:

`mkdir /usr/local/lib/node`

`mkdir /usr/local/lib/node/.libs`

Then, we get the external modules:

`cd ./.libs`

`git clone git://github.com/astro/node-expat.git`

`git clone git://github.com/astro/ltx.git`

`git clone git://github.com/broofa/node-uuid.git`

`git clone git://github.com/akaspin/tav.git`

`git clone git://github.com/documentcloud/underscore.git`

`git clone git://github.com/dhruvbird/eventpipe.git`

`git clone git://github.com/dhruvbird/dns-srv.git`

Then, we build the node-expat library:

`./node-expat/configure`

Finally, we create symbolic links:

`cd ../`

`ln -s ./.libs/node-expat/build/default/node-expat.node ./node-expat.node`

`ln -s ./.libs/ltx/lib ./ltx`

`ln -s ./.libs/node-uuid/uuid.js ./node-uuid.js`

`ln -s ./.libs/tav/index.js ./tav.js`

`ln -s ./.libs/underscore/underscore.js ./underscore.js`

`ln -s ./.libs/eventpipe/eventpipe.js ./eventpipe.js`

`ln -s ./.libs/dns-srv/srv.js ./dns-srv.js`

You can update the external modules from their development repositories using this script (put it in an executable file):

```
#!/usr/bin/env zsh

cd /usr/local/lib/node/.libs

for i in *(/)
do
        cd "$i"
        git pull -a
        cd ../
done
```

Don't forget to build node-expat again if anything was updated.

# node-xmpp-bosh installation #

Once node.js and node-xmpp-bosh dependencies are installed, we can install node-xmpp-bosh itself and change its configuration.

## node-xmpp-bosh itself (from SVN) ##

Get the last node-xmpp-bosh version on the downloads page, or get its trunk using Subversion (recommended):

`svn checkout http://node-xmpp-bosh.googlecode.com/svn/trunk/ /usr/local/lib/bosh`

The use of SVN offers you the possibility to update node-xmpp-bosh quickly to the last development version using the following commands:

`cd /usr/local/lib/bosh`

`svn up`

After an update, you will need to restart node-xmpp-bosh using the init.d command (see after).

## node-xmpp-bosh configuration ##

Copy the node-xmpp-bosh sample configuration file in a new file:

`cp /usr/local/lib/bosh/bosh.conf.example.js /etc/bosh.js.conf`

Then, open it and start configuring it to meet your needs!

A little warn about the logging feature: if your BOSH server will receive a huge amount of data, please consider setting the _logging_ option to _FATAL_ to avoid getting your disk system full quickly.

## node-xmpp-bosh logs ##

To be able to report the crash logs to the node-xmpp-bosh issue tracker, you have to create the logging folder and the logging files:

`mkdir /var/log/bosh`

Then, the two logging files:

`touch /var/log/bosh.log /var/log/bosh.err`

Finally, apply permissive rights to the whole:

`chmod 777 -R /var/log/bosh`

# Startup scripts installation #

Some startup scripts may be useful to make the node-xmpp-bosh process management faster.

## init.d script ##

node-xmpp-bosh will not be launched on system startup once installed, that's why you'd better use the following init.d script. Firstly, create the file:

`touch /etc/init.d/bosh`

Then, apply permissive rights:

`chmod 777 /etc/init.d/bosh`

Open the file:

`nano /etc/init.d/bosh`

Paste the following content:

```
#! /bin/sh
#
# bosh        Start/stop node-xmpp-bosh server
#

### BEGIN INIT INFO
# Provides:          bosh
# Required-Start:    $remote_fs $network $named $time
# Required-Stop:     $remote_fs $network $named $time
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Starts node-xmpp-bosh server
# Description:       Starts node-xmpp-bosh server, an XMPP
#                    BOSH server written in JavaScript.
### END INIT INFO

PATH=/sbin:/bin:/usr/sbin:/usr/bin
NODE_PATH=/usr/local/lib/node
BOSH=/usr/local/bin/bosh
NAME=run-server.js

test -e $BOSH || exit 0

start()
{
    if ! pgrep -f $NAME
    then
        export NODE_PATH
        $BOSH
    fi
}

stop()
{
    killall node
}

case "$1" in
    start)
	echo -n "Starting bosh server"
	start &
    ;;
    stop)
	echo -n "Stopping bosh server"
	stop &
    ;;
    restart)
	echo -n "Restarting bosh server"
	$0 stop
	$0 start
    ;;
    *)
	echo "Usage: $0 {start|stop|restart}" >&2
	exit 1
    ;;
esac

if [ $? -eq 0 ]; then
    echo .
else
    echo " failed."
fi

exit 0
```

Save it (CTRL+O using nano).

Then, you have to create the related command script:

`touch /usr/local/bin/bosh`

Then, apply permissive rights:

`chmod 777 /usr/local/bin/bosh`

Open the file:

`nano /usr/local/bin/bosh`

Paste the following content:

```
#!/usr/bin/env sh
exec /usr/local/lib/bosh/run-server.js "$@" >> /var/log/bosh/bosh.log 2>> /var/log/bosh/bosh.err &
```

Save it (CTRL+O using nano).

Once done, you will be able to start, stop or restart node-xmpp-bosh using this command:

`/etc/init.d/bosh {start|stop|restart}`

## cronjob ##

To avoid any downtime of your BOSH service, you may want to use a cronjob to start node-xmpp-bosh if not started (the check is proceeded every minute).

First, execute this:

`crontab -e`

Then, at the end of the file, paste this:

`*/1 * * * * /etc/init.d/bosh start >>/dev/null`

Save it (CTRL+O using nano), the cronjobs will be updated.

Remember this solution is not the best (not really clean), but is simple and works fine. Advanced users may want to use [daemontools](DaemontoolsSetup.md).

## node.js - Forever ##

You can also use _Forever_ "instead of" _cronjob_ or _daemon tools_.

[Forever](https://github.com/nodejitsu/forever) is _a simple CLI tool for ensuring that a given script runs continuously (i.e. forever)_.

**Install Forever:**
```
sudo npm install forever
```

See [this page](https://github.com/nodejitsu/forever) for help on how to use Forever.