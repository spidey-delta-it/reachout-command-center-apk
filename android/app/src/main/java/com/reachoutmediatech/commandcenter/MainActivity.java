package com.reachoutmediatech.commandcenter;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ReachoutScraperPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
